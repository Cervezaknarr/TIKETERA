const { Op } = require("sequelize");
const Purchase = require("../models/Purchase");
const Event = require("../models/Event");
const Lot = require("../models/Lot");
const Pack = require("../models/Pack");
const Ticket = require("../models/Ticket");
const PurchaseItem = require("../models/PurchaseItem");
const { sequelize } = require("../config/database");
const { packUnitPrice } = require("../utils/packs");
const { itemsOf, pendingByLot, releaseStock, reserveItems } = require("../utils/purchases");
const QRCode = require("qrcode");
const { generateTicketCode } = require("../utils/ticketCode");
const { sendTicketsEmail } = require("../utils/mailer");
const { maskEmail, scrubFreeText } = require("../utils/redact");
const { getProvider } = require("../utils/payments");
const { paymentWindowMinutes } = require("../utils/paymentWindow");
const { isSalesPaused } = require("../utils/paymentAccounts");
const { audit } = require("../utils/audit");

// Formato básico de email (algo@dominio.tld, sin espacios); la validación real es que llegue el mail
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Hasta cuándo puede pagar el comprador (para mostrarle el contador)
const paymentDeadline = (purchase) =>
  new Date(new Date(purchase.createdAt).getTime() + paymentWindowMinutes() * 60 * 1000);

/**
 * Enviar por email las entradas de una compra ya confirmada
 * @param {string} purchaseId - ID de la compra
 */
const sendPurchaseEmail = async (purchaseId) => {
  const purchase = await Purchase.findByPk(purchaseId, { include: [Event] });
  const tickets = await Ticket.findAll({
    where: { purchaseId },
    order: [["createdAt", "ASC"], ["code", "ASC"]],
  });
  return sendTicketsEmail({ purchase, event: purchase.Event, tickets });
};

/**
 * Anular una compra ya paga (devolución, contracargo o decisión del panel): la compra
 * pasa a "refunded" y sus entradas que todavía no se usaron a "void", así el escáner las
 * rechaza. Las que ya entraron no se tocan. Va dentro de una transacción, con la compra
 * bloqueada. El update es condicional: si alguien escanea a la vez, o la entrada se
 * anula o ya entró, nunca las dos
 * @returns {Promise<{ voided: number, used: number }>}
 */
const voidPurchase = async (purchase, transaction) => {
  purchase.status = "refunded";
  await purchase.save({ transaction });
  const [voided] = await Ticket.update(
    { status: "void" },
    { where: { purchaseId: purchase.id, status: "valid" }, transaction }
  );
  const used = await Ticket.count({ where: { purchaseId: purchase.id, status: "used" }, transaction });
  return { voided, used };
};

// Reenvíos recientes por compra: evita que un clic repetido llene la bandeja del comprador
const RESEND_COOLDOWN_MS = 30 * 1000;
const lastResend = new Map();

/**
 * @desc    Anular a mano las entradas de una compra pagada (admin u organizador del
 *          evento), por ejemplo si se devolvió la plata por fuera. No devuelve el dinero
 * @route   POST /api/purchases/event/:eventId/:purchaseId/void
 * @access  Private (admin u organizador del evento)
 */
const voidPurchaseFromPanel = async (req, res) => {
  try {
    // Motivo obligatorio (queda en la auditoría): texto de 3 a 200 caracteres
    const reason = typeof (req.body || {}).reason === "string" ? req.body.reason.trim() : "";
    if (reason.length < 3 || reason.length > 200) {
      return res.status(400).json({
        success: false,
        message: "Indicá el motivo de la anulación (entre 3 y 200 caracteres)",
      });
    }

    const result = await sequelize.transaction(async (transaction) => {
      const purchase = await Purchase.findOne({
        where: { id: req.params.purchaseId, eventId: req.managedEvent.id },
        lock: transaction.LOCK.UPDATE,
        transaction,
      });
      if (!purchase) return { notFound: true };
      if (purchase.status !== "completed") return { notPaid: true };
      const voidResult = await voidPurchase(purchase, transaction);
      // Estricta y dentro de la transacción: si no se puede auditar, la anulación se revierte
      await audit(req, {
        action: "PURCHASE_VOID",
        entityType: "Purchase",
        entityId: purchase.id,
        eventId: req.managedEvent.id,
        details: {
          status: { from: "completed", to: "refunded" },
          ticketsVoided: voidResult.voided,
          ticketsAlreadyUsed: voidResult.used,
          reason: scrubFreeText(reason), // sin emails ni números largos (DNI, teléfonos)
        },
        transaction,
        strict: true,
      });
      return voidResult;
    });

    if (result.notFound) {
      return res.status(404).json({ success: false, message: "Compra no encontrada" });
    }
    if (result.notPaid) {
      return res.status(400).json({
        success: false,
        message: "Solo se pueden anular compras pagas que todavía no fueron anuladas",
      });
    }
    res.json({
      success: true,
      message:
        `Compra anulada: ${result.voided} entrada(s) dejaron de ser válidas` +
        (result.used ? `. ${result.used} ya habían entrado y no se pueden anular` : "") +
        ". Esto no devuelve el dinero: hacelo desde tu cuenta de pagos",
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Error al anular la compra" });
  }
};

/**
 * @desc    Reenviar por email las entradas de una compra pagada (admin u organizador
 *          del evento), por ejemplo si el comprador no recibió el mail o se equivocó
 *          al escribirlo
 * @route   POST /api/purchases/event/:eventId/:purchaseId/resend
 * @access  Private (admin u organizador del evento)
 */
const resendPurchaseEmail = async (req, res) => {
  try {
    const purchase = await Purchase.findOne({
      where: { id: req.params.purchaseId, eventId: req.managedEvent.id },
    });
    if (!purchase) {
      return res.status(404).json({ success: false, message: "Compra no encontrada" });
    }
    if (purchase.status !== "completed") {
      return res.status(400).json({
        success: false,
        message: "La compra todavía no está paga: no tiene entradas para enviar",
      });
    }
    if (Date.now() - (lastResend.get(purchase.id) || 0) < RESEND_COOLDOWN_MS) {
      await audit(req, { action: "TICKETS_RESEND", entityType: "Purchase", entityId: purchase.id, eventId: purchase.eventId, result: "failure", details: { reason: "cooldown", status: 429 } });
      return res.status(429).json({
        success: false,
        message: "Ya se envió hace un momento. Esperá unos segundos antes de reenviar",
      });
    }

    let sent;
    try {
      sent = await sendPurchaseEmail(purchase.id);
    } catch (error) {
      console.error(`Error al reenviar las entradas de la compra ${purchase.id}:`, error);
      await audit(req, { action: "TICKETS_RESEND", entityType: "Purchase", entityId: purchase.id, eventId: purchase.eventId, result: "failure", details: { reason: "send_error", status: 502 } });
      return res.status(502).json({
        success: false,
        message: "No se pudo enviar el email. Probá de nuevo o copiá el link de las entradas",
      });
    }
    if (!sent) {
      await audit(req, { action: "TICKETS_RESEND", entityType: "Purchase", entityId: purchase.id, eventId: purchase.eventId, result: "failure", details: { reason: "mail_not_configured", status: 503 } });
      return res.status(503).json({
        success: false,
        message: "El envío de emails todavía no está configurado. Copiá el link y mandáselo a mano",
      });
    }

    lastResend.set(purchase.id, Date.now());
    await audit(req, {
      action: "TICKETS_RESEND",
      entityType: "Purchase",
      entityId: purchase.id,
      eventId: purchase.eventId,
    });
    res.json({ success: true, message: `Entradas enviadas a ${maskEmail(purchase.buyerEmail)}` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Error al reenviar las entradas" });
  }
};

// "2× General, 3× VIP" para mostrar en listados y emails (la columna guarda 60 caracteres)
const itemsSummary = (items) => {
  const text = items.map((i) => `${i.quantity}× ${i.lotName}`).join(", ");
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
};

/**
 * @desc    Crear una compra pendiente y la sesión de pago en la pasarela activa.
 *          La compra puede llevar varios lotes (un carrito) y se paga de una vez
 * @route   POST /api/purchases/checkout
 * @access  Public
 * @body    { eventId, buyerName, buyerEmail, items: [{ lotId, quantity }],
 *            packs: [{ packId, count }] }
 *          items = entradas sueltas; packs = paquetes con descuento (count paquetes de
 *          packId, cada uno con las entradas y el % de la promo). Se pueden combinar.
 *          El formato anterior { lotId, quantity } sigue funcionando
 */
const createCheckoutSession = async (req, res) => {
  try {
    // El admin pausa las ventas, por ejemplo mientras cambia la cuenta de cobro
    if (await isSalesPaused()) {
      return res.status(503).json({
        success: false,
        message: "Las ventas están pausadas momentáneamente. Probá de nuevo en unos minutos",
      });
    }

    const { eventId, buyerEmail, buyerName } = req.body;
    const requestedPacks = req.body.packs === undefined ? [] : req.body.packs;
    const requested = req.body.items === undefined
      ? requestedPacks.length ? [] : [{ lotId: req.body.lotId, quantity: req.body.quantity }]
      : req.body.items;

    // Verificar campos obligatorios
    const invalidItems =
      !Array.isArray(requested) ||
      !Array.isArray(requestedPacks) ||
      requested.length + requestedPacks.length < 1 ||
      requested.length > 20 ||
      requestedPacks.length > 20 ||
      requested.some((i) => !i || !Number.isInteger(i.quantity) || i.quantity < 1) ||
      requestedPacks.some(
        (p) => !p || typeof p.packId !== "string" || !Number.isInteger(p.count) || p.count < 1
      );
    if (!eventId || !buyerEmail || !buyerName || invalidItems) {
      return res.status(400).json({
        success: false,
        message: "Por favor proporciona todos los campos requeridos",
      });
    }
    if (typeof buyerEmail !== "string" || buyerEmail.length > 254 || !EMAIL_REGEX.test(buyerEmail.trim())) {
      return res.status(400).json({
        success: false,
        message: "El email no es válido",
      });
    }
    if (typeof buyerName !== "string" || buyerName.length > 100) {
      return res.status(400).json({
        success: false,
        message: "El nombre es demasiado largo (máximo 100 caracteres)",
      });
    }

    // Buscar el evento
    const event = await Event.findByPk(eventId);

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Evento no encontrado",
      });
    }

    if (event.status !== "published") {
      return res.status(400).json({
        success: false,
        message: "Este evento no está a la venta",
      });
    }

    // El organizador puede pausar las ventas de su evento (la pausa general es aparte)
    if (event.salesPaused) {
      return res.status(503).json({
        success: false,
        message: "Las ventas de este evento están pausadas momentáneamente. Probá de nuevo en unos minutos",
      });
    }

    // Cada evento cobra con su propia cuenta de Mercado Pago: sin una activa no se vende
    if (getProvider().name === "mercadopago" && !event.paymentAccountId) {
      return res.status(503).json({
        success: false,
        message: "Este evento todavía no tiene el cobro configurado. Probá de nuevo más tarde",
      });
    }

    // Topes contra el acaparamiento: sin ellos, una sola compra o un bot podría
    // dejar el evento "agotado" reservando todo sin pagar. El tope cuenta todas
    // las entradas del carrito
    const maxPerPurchase = Number(process.env.MAX_TICKETS_PER_PURCHASE) || 10;
    // Tope barato antes de tocar la base: los paquetes se cuentan abajo, con su cantidad real
    if (requested.reduce((sum, i) => sum + i.quantity, 0) > maxPerPurchase) {
      return res.status(400).json({
        success: false,
        message: `Podés comprar hasta ${maxPerPurchase} entradas por compra`,
      });
    }
    const maxPending = Number(process.env.MAX_PENDING_PER_EMAIL) || 5;

    // Cada lote tiene que ser del evento. Si el evento tiene uno solo, no hace
    // falta indicarlo. Un mismo lote repetido se suma
    const lots = await Lot.findAll({ where: { eventId } });
    const wanted = new Map();
    for (const { lotId, quantity } of requested) {
      const lot = lotId ? lots.find((l) => l.id === lotId) : lots.length === 1 ? lots[0] : null;
      if (!lot) {
        return res.status(400).json({
          success: false,
          message: lotId ? "El lote no pertenece a este evento" : "Elegí un tipo de entrada",
        });
      }
      wanted.set(lot.id, { lot, quantity: (wanted.get(lot.id)?.quantity || 0) + quantity });
    }
    // Paquetes: el servidor define cuántas entradas trae y qué descuento tiene cada uno;
    // del cliente solo se toma qué paquete y cuántos. Cada paquete es una línea aparte
    // (su precio es distinto al de las entradas sueltas del mismo lote)
    const lines = [...wanted.values()].map(({ lot, quantity }) => ({ lot, quantity, pack: null }));
    if (requestedPacks.length) {
      const packs = await Pack.findAll({ where: { eventId } });
      const counts = new Map();
      for (const { packId, count } of requestedPacks) {
        counts.set(packId, (counts.get(packId) || 0) + count);
      }
      for (const [packId, count] of counts) {
        const pack = packs.find((p) => p.id === packId);
        const lot = pack && lots.find((l) => l.id === pack.lotId);
        if (!pack || !lot) {
          return res.status(400).json({
            success: false,
            message: "El paquete ya no está disponible. Actualizá la página y elegí de nuevo",
          });
        }
        lines.push({ lot, quantity: pack.quantity * count, pack });
      }
    }
    const totalQuantity = lines.reduce((sum, l) => sum + l.quantity, 0);
    if (totalQuantity > maxPerPurchase) {
      return res.status(400).json({
        success: false,
        message: `Podés comprar hasta ${maxPerPurchase} entradas por compra`,
      });
    }
    // Entradas por lote (sueltas + paquetes), para el cupo y los topes
    const quantityByLot = new Map();
    for (const { lot, quantity } of lines) {
      quantityByLot.set(lot.id, (quantityByLot.get(lot.id) || 0) + quantity);
    }
    // Siempre en el mismo orden: dos carritos simultáneos no se bloquean entre sí
    const lotsToLock = [...quantityByLot.keys()].sort();

    // Reservar el cupo y crear la compra en una sola transacción. El precio se
    // fija ahora: editar el lote después no cambia lo que se está pagando
    const reservation = await sequelize.transaction(async (transaction) => {
      // Bloquear los lotes: los topes se cuentan con las compras pendientes y dos
      // pedidos simultáneos no pueden pasar los dos
      const locked = new Map();
      for (const lotId of lotsToLock) {
        locked.set(lotId, await Lot.findByPk(lotId, { transaction, lock: transaction.LOCK.UPDATE }));
      }

      const pendingForEmail = await Purchase.count({
        where: {
          eventId,
          status: "pending",
          [Op.and]: sequelize.where(
            sequelize.fn("lower", sequelize.col("buyerEmail")),
            String(buyerEmail).toLowerCase()
          ),
        },
        transaction,
      });
      if (pendingForEmail >= maxPending) return { limit: "email" };

      // Las compras sin pagar no pueden retener más de un porcentaje del lote
      // (nunca menos de lo que permite una compra), así un bot no lo agota
      const held = await pendingByLot(eventId, transaction);
      const percent = Number(process.env.MAX_PENDING_LOT_PERCENT) || 40;
      for (const lotId of lotsToLock) {
        const lot = locked.get(lotId);
        const quantity = quantityByLot.get(lotId);
        const pendingCap = Math.max(Math.floor((lot.quantity * percent) / 100), maxPerPurchase);
        // Si ya no queda cupo, el mensaje correcto es el de agotado, no este
        if (
          lot.ticketsAvailable >= quantity &&
          (held.get(lot.id) || 0) + quantity > pendingCap
        ) {
          return { limit: "lot", lot };
        }
      }

      // El precio sale del lote bloqueado; en un paquete lleva el descuento de la promo
      // (unitPrice ya descontado: es lo que se le cobra por entrada)
      const items = lines.map(({ lot, quantity, pack }) => {
        const current = locked.get(lot.id);
        return {
          lotId: lot.id,
          lotName: current.name,
          unitPrice: pack
            ? packUnitPrice(current.price, pack.discountPercent)
            : Number(current.price),
          quantity,
          packSize: pack ? pack.quantity : null,
          discountPercent: pack ? Number(pack.discountPercent) : null,
        };
      });
      const failed = await reserveItems(items, transaction);
      if (failed) return { soldOut: lots.find((l) => l.id === failed.lotId) };

      const totalPrice = items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
      const single = items.length === 1 ? items[0] : null;
      const purchase = await Purchase.create(
        {
          eventId,
          // Un solo lote: se guarda también en la compra, como antes del carrito
          lotId: single ? single.lotId : null,
          lotName: single ? single.lotName : itemsSummary(items),
          unitPrice: single ? single.unitPrice : null,
          buyerEmail,
          buyerName,
          quantity: totalQuantity,
          totalPrice: Math.round(totalPrice * 100) / 100,
          status: "pending",
        },
        { transaction }
      );
      await PurchaseItem.bulkCreate(
        items.map((item) => ({ ...item, purchaseId: purchase.id })),
        { transaction }
      );
      return { purchase, items };
    });

    if (reservation.limit === "email") {
      return res.status(429).json({
        success: false,
        message:
          "Tenés varias compras sin terminar de pagar. Completalas o esperá unos minutos para volver a intentar",
      });
    }
    if (reservation.limit === "lot") {
      return res.status(429).json({
        success: false,
        message: `Hay muchas compras en curso para ${reservation.lot.name}. Probá de nuevo en unos minutos`,
      });
    }
    if (reservation.soldOut) {
      const { name } = reservation.soldOut;
      const { ticketsAvailable } = await Lot.findByPk(reservation.soldOut.id);
      return res.status(400).json({
        success: false,
        message:
          ticketsAvailable < 1
            ? `El lote ${name} está agotado`
            : `Solo quedan ${ticketsAvailable} entradas disponibles en ${name}`,
      });
    }
    const { purchase, items } = reservation;

    // Crear el pago en la pasarela. Si falla, se libera el cupo reservado
    let payment;
    try {
      payment = await getProvider().createPayment({ purchase, event, items });
      purchase.paymentGatewayId = payment.gatewayId;
      purchase.paymentAccountId = payment.accountId || null;
      await purchase.save();
    } catch (error) {
      await sequelize.transaction(async (transaction) => {
        purchase.status = "failed";
        await purchase.save({ transaction });
        await releaseStock(purchase, transaction);
      });
      throw error;
    }

    res.status(201).json({
      success: true,
      purchase: {
        id: purchase.id,
        eventId: purchase.eventId,
        lotName: purchase.lotName,
        items: items.map(({ lotName, unitPrice, quantity, packSize, discountPercent }) => ({
          lotName, unitPrice, quantity, packSize, discountPercent,
        })),
        buyerEmail: purchase.buyerEmail,
        quantity: purchase.quantity,
        totalPrice: purchase.totalPrice,
        status: purchase.status,
        paymentGatewayId: purchase.paymentGatewayId,
        accessToken: purchase.accessToken,
        expiresAt: paymentDeadline(purchase),
      },
      // URL de la pasarela a la que redirigir al comprador (null = pago simulado)
      checkoutUrl: payment.checkoutUrl,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Error al crear la sesión de checkout",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

/**
 * @desc    Recibir la notificación de pago de la pasarela
 * @route   POST /api/purchases/webhook
 * @access  Public (la autenticidad la verifica la pasarela activa)
 */
const handlePaymentWebhook = async (req, res) => {
  try {
    // La pasarela verifica que la notificación sea auténtica y devuelve el
    // estado real del pago; nunca se confía en el estado que trae el body
    const notification = await getProvider().resolveWebhook(req);

    if (!notification) {
      return res.status(400).json({
        success: false,
        message: "Notificación de pago inválida",
      });
    }

    const { gatewayId: paymentGatewayId, status, amount, currency } = notification;

    // Pago todavía en curso: no hay nada que hacer, la pasarela avisará después
    if (status === "pending") {
      return res.status(200).json({
        success: true,
        message: "Pago pendiente",
      });
    }

    // La pasarela puede mandar el mismo webhook varias veces: todo se hace en una
    // transacción con la compra bloqueada, y solo se procesa si sigue en "pending"
    let mismatchPurchaseId = null;
    let outcome = null; // { id, eventId, ...details } para auditar tras el commit
    const result = await sequelize.transaction(async (transaction) => {
      const purchase = await Purchase.findOne({
        where: { paymentGatewayId },
        lock: transaction.LOCK.UPDATE,
        transaction,
      });

      if (!purchase) return "not_found";

      // La cuenta con la que se consultó el pago debe ser la de la compra; si no,
      // un tercero podría confirmar/anular compras ajenas con un pago propio
      // Falla cerrado: si la pasarela no informa la clave `accountId`,
      // no se puede comprobar la cuenta y se trata como mismatch
      const accountUnknown = notification.accountId === undefined;
      if (
        accountUnknown ||
        (notification.accountId !== undefined &&
          (notification.accountId || null) !== (purchase.paymentAccountId || null))
      ) {
        console.error(`WEBHOOK_ACC_MISMATCH purchase=${purchase.id}`);
        mismatchPurchaseId = { id: purchase.id, eventId: purchase.eventId };
        return "not_found";
      }

      // Pago aprobado que llega después de que la compra venció y se liberó su
      // cupo (por ejemplo, un pago en efectivo): se intenta reservar de nuevo
      const lateApproval = status === "approved" && purchase.status === "failed";
      if (status === "refunded" && purchase.status === "completed") {
        const { voided, used } = await voidPurchase(purchase, transaction);
        console.error(
          `COMPRA DEVUELTA O CONTRACARGADA: la compra ${purchase.id} (${maskEmail(purchase.buyerEmail)}) pasó a "refunded"; ` +
            `${voided} entrada(s) anulada(s)${used ? `, ${used} ya habían entrado` : ""}`
        );
        outcome = { id: purchase.id, eventId: purchase.eventId, ticketsVoided: voided, ticketsAlreadyUsed: used };
        // Estricta y dentro de la transacción: sin registro de auditoría no se anula
        await audit(req, {
          action: "PURCHASE_VOID_AUTO",
          entityType: "Purchase",
          entityId: purchase.id,
          eventId: purchase.eventId,
          actor: null,
          details: {
            status: { from: "completed", to: "refunded" },
            ticketsVoided: voided,
            ticketsAlreadyUsed: used,
          },
          transaction,
          strict: true,
        });
        return "voided";
      }
      if (purchase.status !== "pending" && !lateApproval) return "already_processed";

      if (status === "approved") {
        // Si la pasarela informa el monto cobrado, tiene que ser el de la compra: no se
        // emiten entradas por un pago menor (o en otra moneda). La compra queda como estaba
        const paidAmount = amount === undefined ? null : Math.round(Number(amount) * 100);
        if (
          paidAmount !== null &&
          (paidAmount !== Math.round(Number(purchase.totalPrice) * 100) ||
            (currency && currency !== "ARS"))
        ) {
          outcome = { id: purchase.id, eventId: purchase.eventId };
          return "amount_mismatch";
        }

        const items = await itemsOf(purchase, transaction);
        if (lateApproval && (await reserveItems(items, transaction))) {
          outcome = { id: purchase.id, eventId: purchase.eventId };
          return "paid_without_stock";
        }
        purchase.status = "completed";
        await purchase.save({ transaction });

        // Una entrada por persona, cada una con su propio código y su lote
        const tickets = items.flatMap((item) =>
          Array.from({ length: item.quantity }, () => ({
            eventId: purchase.eventId,
            purchaseId: purchase.id,
            lotId: item.lotId,
            lotName: item.lotName,
            code: generateTicketCode(),
          }))
        );
        await Ticket.bulkCreate(tickets, { transaction });
        outcome = { id: purchase.id, eventId: purchase.eventId, confirmed: true, tickets: tickets.length };

        // El email se manda después del commit, así nunca llega una entrada que no existe
        transaction.afterCommit(() => {
          sendPurchaseEmail(purchase.id).catch((error) =>
            console.error(`Error al enviar entradas de la compra ${purchase.id}:`, error)
          );
        });
      } else if (status === "rejected" || status === "refunded") {
        purchase.status = "failed";
        await purchase.save({ transaction });

        // Si el pago falló, devolver las entradas al inventario
        await releaseStock(purchase, transaction);
      }

      return "processed";
    });

    if (result === "not_found") {
      // Fuera de la transacción: dentro, el registro se perdería si hiciera rollback
      if (mismatchPurchaseId) {
        await audit(req, {
          action: "WEBHOOK_ACC_MISMATCH",
          entityType: "Purchase",
          entityId: mismatchPurchaseId.id,
          eventId: mismatchPurchaseId.eventId,
          result: "denied",
          actor: null,
        });
      }
      return res.status(404).json({
        success: false,
        message: "Compra no encontrada",
      });
    }

    if (result === "processed" && outcome && outcome.confirmed) {
      // Tras el commit: el pago confirmado queda registrado (sin datos del comprador)
      await audit(req, {
        action: "PAYMENT_CONFIRMED",
        entityType: "Purchase",
        entityId: outcome.id,
        eventId: outcome.eventId,
        actor: null,
        details: { tickets: outcome.tickets },
      });
    }

    if (result === "amount_mismatch") {
      await audit(req, {
        action: "PAYMENT_AMOUNT_MISMATCH",
        entityType: "Purchase",
        entityId: outcome.id,
        eventId: outcome.eventId,
        result: "denied",
        actor: null,
      });
      // Hay que revisar el pago a mano. Se responde 200 para que la pasarela no reintente
      console.error(
        `PAGO CON MONTO DISTINTO: la compra con pasarela ${paymentGatewayId} se aprobó por ${amount} ${currency || ""} y no coincide con lo que se cobraba. No se emitieron entradas.`
      );
      return res.status(200).json({
        success: true,
        message: "El monto pagado no coincide con la compra: requiere revisión",
      });
    }

    if (result === "paid_without_stock") {
      await audit(req, {
        action: "PAYMENT_NO_STOCK",
        entityType: "Purchase",
        entityId: outcome.id,
        eventId: outcome.eventId,
        result: "failure",
        actor: null,
      });
      // Hay que devolverle la plata al comprador a mano. Se responde 200 para que
      // la pasarela no siga reintentando el aviso
      console.error(
        `PAGO APROBADO SIN CUPO: la compra con pasarela ${paymentGatewayId} se pagó después de vencer y el evento ya no tiene entradas. Hay que reembolsarla.`
      );
      return res.status(200).json({
        success: true,
        message: "Pago aprobado sin cupo disponible: requiere reembolso",
      });
    }

    // Responder al webhook (normalmente con un 200 OK)
    res.status(200).json({
      success: true,
      message:
        result === "already_processed"
          ? "Webhook ya procesado anteriormente"
          : `Webhook procesado correctamente. Estado: ${status}`,
    });
  } catch (error) {
    console.error(error);
    // Responder con error para que la pasarela reintente: no se emitió ninguna entrada
    res.status(500).json({
      success: false,
      message: "Error al procesar el webhook",
    });
  }
};

/**
 * @desc    Saber si las ventas están pausadas (la web lo usa para avisar antes de comprar)
 * @route   GET /api/purchases/status
 * @access  Public
 */
const getSalesStatus = async (req, res) => {
  try {
    res.json({ success: true, salesPaused: await isSalesPaused() });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Error al consultar el estado de las ventas" });
  }
};

/**
 * @desc    Obtener todas las compras de un evento
 * @route   GET /api/purchases/event/:eventId
 * @access  Private
 */
const getEventPurchases = async (req, res) => {
  try {
    const { eventId } = req.params;

    // Buscar el evento
    const event = await Event.findByPk(eventId);

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Evento no encontrado",
      });
    }

    // El acceso (admin u organizador de este evento) lo verifica el middleware eventManager
    // Buscar las compras del evento, con sus entradas para ver quién ya ingresó
    const purchases = await Purchase.findAll({
      where: { eventId },
      include: [
        {
          model: Ticket,
          attributes: ["code", "status", "holderName", "usedAt", "lotName"],
        },
        {
          model: PurchaseItem,
          as: "items",
          attributes: ["lotName", "unitPrice", "quantity", "packSize", "discountPercent"],
        },
      ],
      order: [
        ["createdAt", "DESC"],
        [Ticket, "code", "ASC"],
      ],
    });

    res.json({
      success: true,
      purchases,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Error al obtener las compras del evento",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

/**
 * @desc    Ver las entradas de una compra con su QR (link que recibe el comprador)
 * @route   GET /api/purchases/tickets/:accessToken
 * @access  Public (el token largo y aleatorio funciona como contraseña)
 */
const getPurchaseTickets = async (req, res) => {
  try {
    const purchase = await Purchase.findOne({
      where: { accessToken: req.params.accessToken },
      include: [{ model: Event, attributes: ["title", "date", "location"] }],
    });

    if (!purchase) {
      return res.status(404).json({
        success: false,
        message: "Compra no encontrada",
      });
    }

    const tickets = await Ticket.findAll({
      where: { purchaseId: purchase.id },
      order: [["lotName", "ASC"], ["createdAt", "ASC"], ["code", "ASC"]],
    });

    res.json({
      success: true,
      purchase: {
        buyerName: purchase.buyerName,
        buyerEmail: purchase.buyerEmail,
        lotName: purchase.lotName,
        items: (await itemsOf(purchase)).map(
          ({ lotName, unitPrice, quantity, packSize, discountPercent }) => ({
            lotName,
            unitPrice,
            quantity,
            packSize: packSize || null,
            discountPercent: discountPercent == null ? null : Number(discountPercent),
          })
        ),
        quantity: purchase.quantity,
        totalPrice: purchase.totalPrice,
        status: purchase.status,
        expiresAt: purchase.status === "pending" ? paymentDeadline(purchase) : null,
      },
      event: purchase.Event,
      tickets: await Promise.all(
        tickets.map(async (ticket) => ({
          code: ticket.code,
          status: ticket.status,
          holderName: ticket.holderName,
          lotName: ticket.lotName || purchase.lotName,
          qr: await QRCode.toDataURL(ticket.code, { width: 300, margin: 2 }),
        }))
      ),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Error al obtener las entradas",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

module.exports = {
  createCheckoutSession,
  handlePaymentWebhook,
  getSalesStatus,
  getEventPurchases,
  getPurchaseTickets,
  resendPurchaseEmail,
  voidPurchaseFromPanel,
  sendPurchaseEmail,
  voidPurchase,
};
