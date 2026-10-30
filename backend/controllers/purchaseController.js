const { Op } = require("sequelize");
const Purchase = require("../models/Purchase");
const Event = require("../models/Event");
const Lot = require("../models/Lot");
const Ticket = require("../models/Ticket");
const { sequelize } = require("../config/database");
const { releaseStock, reserveStock } = require("../utils/purchases");
const QRCode = require("qrcode");
const { generateTicketCode } = require("../utils/ticketCode");
const { sendTicketsEmail } = require("../utils/mailer");
const { getProvider } = require("../utils/payments");
const { paymentWindowMinutes } = require("../utils/paymentWindow");

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
  await sendTicketsEmail({ purchase, event: purchase.Event, tickets });
};

/**
 * @desc    Crear una compra pendiente y la sesión de pago en la pasarela activa
 * @route   POST /api/purchases/checkout
 * @access  Public
 */
const createCheckoutSession = async (req, res) => {
  try {
    const { eventId, lotId, buyerEmail, buyerName, quantity } = req.body;

    // Verificar campos obligatorios
    if (!eventId || !buyerEmail || !buyerName || !Number.isInteger(quantity) || quantity < 1) {
      return res.status(400).json({
        success: false,
        message: "Por favor proporciona todos los campos requeridos",
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

    // Topes contra el acaparamiento: sin ellos, una sola compra o un bot podría
    // dejar el evento "agotado" reservando todo sin pagar
    const maxPerPurchase = Number(process.env.MAX_TICKETS_PER_PURCHASE) || 10;
    if (quantity > maxPerPurchase) {
      return res.status(400).json({
        success: false,
        message: `Podés comprar hasta ${maxPerPurchase} entradas por compra`,
      });
    }
    const maxPending = Number(process.env.MAX_PENDING_PER_EMAIL) || 5;

    // El lote tiene que ser del evento. Si el evento tiene uno solo, no hace
    // falta indicarlo
    const lots = await Lot.findAll({ where: { eventId } });
    const lot = lotId ? lots.find((l) => l.id === lotId) : lots.length === 1 ? lots[0] : null;
    if (!lot) {
      return res.status(400).json({
        success: false,
        message: lotId ? "El lote no pertenece a este evento" : "Elegí un tipo de entrada",
      });
    }

    // Reservar el cupo y crear la compra en una sola transacción. El precio se
    // fija ahora: editar el lote después no cambia lo que se está pagando
    const unitPrice = Number(lot.price);
    const reservation = await sequelize.transaction(async (transaction) => {
      // Bloquear el lote: los topes se cuentan con las compras pendientes y dos
      // pedidos simultáneos no pueden pasar los dos
      const locked = await Lot.findByPk(lot.id, { transaction, lock: transaction.LOCK.UPDATE });

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
      const pendingTickets =
        (await Purchase.sum("quantity", {
          where: { lotId: lot.id, status: "pending" },
          transaction,
        })) || 0;
      const percent = Number(process.env.MAX_PENDING_LOT_PERCENT) || 40;
      const pendingCap = Math.max(Math.floor((lot.quantity * percent) / 100), maxPerPurchase);
      // Si ya no queda cupo, el mensaje correcto es el de agotado, no este
      if (locked.ticketsAvailable >= quantity && pendingTickets + quantity > pendingCap) {
        return { limit: "lot" };
      }

      if (!(await reserveStock(lot.id, quantity, transaction))) return null;

      return Purchase.create(
        {
          eventId,
          lotId: lot.id,
          lotName: lot.name,
          unitPrice,
          buyerEmail,
          buyerName,
          quantity,
          totalPrice: Math.round(unitPrice * quantity * 100) / 100,
          status: "pending",
        },
        { transaction }
      );
    });

    if (reservation && reservation.limit === "email") {
      return res.status(429).json({
        success: false,
        message:
          "Tenés varias compras sin terminar de pagar. Completalas o esperá unos minutos para volver a intentar",
      });
    }
    if (reservation && reservation.limit === "lot") {
      return res.status(429).json({
        success: false,
        message: `Hay muchas compras en curso para ${lot.name}. Probá de nuevo en unos minutos`,
      });
    }
    if (!reservation) {
      const { ticketsAvailable } = await Lot.findByPk(lot.id);
      return res.status(400).json({
        success: false,
        message:
          ticketsAvailable < 1
            ? `El lote ${lot.name} está agotado`
            : `Solo quedan ${ticketsAvailable} entradas disponibles en ${lot.name}`,
      });
    }
    const purchase = reservation;

    // Crear el pago en la pasarela. Si falla, se libera el cupo reservado
    let payment;
    try {
      payment = await getProvider().createPayment({ purchase, event });
      purchase.paymentGatewayId = payment.gatewayId;
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

    const { gatewayId: paymentGatewayId, status } = notification;

    // Pago todavía en curso: no hay nada que hacer, la pasarela avisará después
    if (status === "pending") {
      return res.status(200).json({
        success: true,
        message: "Pago pendiente",
      });
    }

    // La pasarela puede mandar el mismo webhook varias veces: todo se hace en una
    // transacción con la compra bloqueada, y solo se procesa si sigue en "pending"
    const result = await sequelize.transaction(async (transaction) => {
      const purchase = await Purchase.findOne({
        where: { paymentGatewayId },
        lock: transaction.LOCK.UPDATE,
        transaction,
      });

      if (!purchase) return "not_found";

      // Pago aprobado que llega después de que la compra venció y se liberó su
      // cupo (por ejemplo, un pago en efectivo): se intenta reservar de nuevo
      const lateApproval = status === "approved" && purchase.status === "failed";
      if (purchase.status !== "pending" && !lateApproval) return "already_processed";

      if (status === "approved") {
        if (lateApproval && !(await reserveStock(purchase.lotId, purchase.quantity, transaction))) {
          return "paid_without_stock";
        }
        purchase.status = "completed";
        await purchase.save({ transaction });

        // Una entrada por persona, cada una con su propio código
        const tickets = Array.from({ length: purchase.quantity }, () => ({
          eventId: purchase.eventId,
          purchaseId: purchase.id,
          code: generateTicketCode(),
        }));
        await Ticket.bulkCreate(tickets, { transaction });

        // El email se manda después del commit, así nunca llega una entrada que no existe
        transaction.afterCommit(() => {
          sendPurchaseEmail(purchase.id).catch((error) =>
            console.error(`Error al enviar entradas de la compra ${purchase.id}:`, error)
          );
        });
      } else if (status === "rejected") {
        purchase.status = "failed";
        await purchase.save({ transaction });

        // Si el pago falló, devolver las entradas al inventario
        await releaseStock(purchase, transaction);
      }

      return "processed";
    });

    if (result === "not_found") {
      return res.status(404).json({
        success: false,
        message: "Compra no encontrada",
      });
    }

    if (result === "paid_without_stock") {
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

    // Verificar si el usuario es el propietario del evento o admin
    if (event.userId !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "No tienes permiso para ver las compras de este evento",
      });
    }

    // Buscar las compras del evento, con sus entradas para ver quién ya ingresó
    const purchases = await Purchase.findAll({
      where: { eventId },
      include: [
        {
          model: Ticket,
          attributes: ["code", "status", "holderName", "usedAt"],
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
      order: [["createdAt", "ASC"], ["code", "ASC"]],
    });

    res.json({
      success: true,
      purchase: {
        buyerName: purchase.buyerName,
        buyerEmail: purchase.buyerEmail,
        lotName: purchase.lotName,
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
  getEventPurchases,
  getPurchaseTickets,
};
