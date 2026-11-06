const Event = require("../models/Event");
const Purchase = require("../models/Purchase");
const Ticket = require("../models/Ticket");
const { sequelize } = require("../config/database");
const { generateTicketCode } = require("../utils/ticketCode");
const { audit } = require("../utils/audit");
const { maskEmail } = require("../utils/redact");
const { sendPurchaseEmail, voidPurchase } = require("./purchaseController");

// Cortesías: entradas que el admin emite sin pasar por Mercado Pago. Son una compra
// "completed" con courtesy = true, total 0 y sin lote (no descuenta cupo de ningún lote);
// cada entrada tiene su propio código y el escáner las trata igual que cualquier otra.

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PER_COURTESY = 20;

// Reenvíos recientes por cortesía: evita que un clic repetido llene la bandeja
const SEND_COOLDOWN_MS = 30 * 1000;
const lastSend = new Map();

const text = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

// Datos del destinatario; devuelve { error } o { name, email }. Con `partial` solo valida
// lo que viene
const parseRecipient = (body, partial = false) => {
  const out = {};
  if (!partial || body.name !== undefined) {
    out.name = text(body.name, 100);
    if (!out.name) return { error: "Indicá el nombre de quien recibe la cortesía" };
  }
  if (!partial || body.email !== undefined) {
    out.email = text(body.email, 254).toLowerCase();
    if (!EMAIL_REGEX.test(out.email)) return { error: "El email no es válido" };
  }
  return out;
};

const present = (purchase) => ({
  id: purchase.id,
  buyerName: purchase.buyerName,
  buyerEmail: purchase.buyerEmail,
  quantity: purchase.quantity,
  status: purchase.status,
  accessToken: purchase.accessToken,
  createdAt: purchase.createdAt,
  Tickets: (purchase.Tickets || []).map((t) => ({
    code: t.code,
    status: t.status,
    usedAt: t.usedAt,
  })),
});

const findCourtesy = (req) =>
  Purchase.findOne({
    where: { id: req.params.id, eventId: req.params.eventId, courtesy: true },
    include: [{ model: Ticket, attributes: ["code", "status", "usedAt"] }],
    order: [[Ticket, "code", "ASC"]],
  });

/**
 * @desc    Cortesías de un evento
 * @route   GET /api/courtesies/event/:eventId
 * @access  Admin
 */
const listCourtesies = async (req, res) => {
  try {
    const event = await Event.findByPk(req.params.eventId, { attributes: ["id", "title"] });
    if (!event) return res.status(404).json({ success: false, message: "Evento no encontrado" });
    const courtesies = await Purchase.findAll({
      where: { eventId: event.id, courtesy: true },
      include: [{ model: Ticket, attributes: ["code", "status", "usedAt"] }],
      order: [
        ["createdAt", "DESC"],
        [Ticket, "code", "ASC"],
      ],
    });
    res.json({ success: true, event, courtesies: courtesies.map(present) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Error al obtener las cortesías" });
  }
};

/**
 * @desc    Generar una cortesía: N entradas para una persona, sin pago. No manda el mail:
 *          eso se hace aparte con el botón de enviar
 * @route   POST /api/courtesies/event/:eventId
 * @access  Admin
 * @body    { name, email, quantity }
 */
const createCourtesy = async (req, res) => {
  try {
    const event = await Event.findByPk(req.params.eventId);
    if (!event) return res.status(404).json({ success: false, message: "Evento no encontrado" });
    if (event.status === "cancelled") {
      return res.status(400).json({ success: false, message: "El evento está cancelado: no se pueden generar cortesías" });
    }

    const recipient = parseRecipient(req.body || {});
    if (recipient.error) return res.status(400).json({ success: false, message: recipient.error });

    const quantity = req.body.quantity === undefined ? 1 : req.body.quantity;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_PER_COURTESY) {
      return res.status(400).json({
        success: false,
        message: `La cantidad tiene que ser un número entero entre 1 y ${MAX_PER_COURTESY}`,
      });
    }

    const purchase = await sequelize.transaction(async (transaction) => {
      const created = await Purchase.create(
        {
          eventId: event.id,
          buyerName: recipient.name,
          buyerEmail: recipient.email,
          quantity,
          totalPrice: 0,
          status: "completed",
          courtesy: true,
        },
        { transaction }
      );
      await Ticket.bulkCreate(
        Array.from({ length: quantity }, () => ({
          eventId: event.id,
          purchaseId: created.id,
          code: generateTicketCode(),
        })),
        { transaction }
      );
      await audit(req, {
        action: "COURTESY_CREATE",
        entityType: "Purchase",
        entityId: created.id,
        eventId: event.id,
        details: { quantity },
        transaction,
        strict: true,
      });
      return created;
    });

    res.status(201).json({ success: true, courtesy: present(await findCourtesyById(purchase.id)) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Error al generar la cortesía" });
  }
};

const findCourtesyById = (id) =>
  Purchase.findByPk(id, {
    include: [{ model: Ticket, attributes: ["code", "status", "usedAt"] }],
    order: [[Ticket, "code", "ASC"]],
  });

/**
 * @desc    Corregir el nombre o el email de quien recibe la cortesía
 * @route   PUT /api/courtesies/event/:eventId/:id
 * @access  Admin
 * @body    { name?, email? }
 */
const updateCourtesy = async (req, res) => {
  try {
    const courtesy = await findCourtesy(req);
    if (!courtesy) return res.status(404).json({ success: false, message: "Cortesía no encontrada" });

    const body = req.body || {};
    if (body.name === undefined && body.email === undefined) {
      return res.status(400).json({ success: false, message: "No hay nada para cambiar" });
    }
    const recipient = parseRecipient(body, true);
    if (recipient.error) return res.status(400).json({ success: false, message: recipient.error });

    const changed = [];
    if (recipient.name !== undefined && recipient.name !== courtesy.buyerName) changed.push("name");
    if (recipient.email !== undefined && recipient.email !== courtesy.buyerEmail) changed.push("email");
    if (changed.length) {
      await courtesy.update({
        ...(recipient.name !== undefined && { buyerName: recipient.name }),
        ...(recipient.email !== undefined && { buyerEmail: recipient.email }),
      });
      await audit(req, {
        action: "COURTESY_UPDATE",
        entityType: "Purchase",
        entityId: courtesy.id,
        eventId: courtesy.eventId,
        details: { fields: changed }, // solo qué campos, nunca el email
      });
    }
    res.json({ success: true, courtesy: present(courtesy) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Error al actualizar la cortesía" });
  }
};

/**
 * @desc    Enviar (o reenviar) por email las entradas de una cortesía
 * @route   POST /api/courtesies/event/:eventId/:id/send
 * @access  Admin
 */
const sendCourtesy = async (req, res) => {
  const fail = async (courtesy, reason, status, message) => {
    await audit(req, {
      action: "COURTESY_SEND",
      entityType: "Purchase",
      entityId: courtesy.id,
      eventId: courtesy.eventId,
      result: "failure",
      details: { reason, status },
    });
    return res.status(status).json({ success: false, message });
  };
  try {
    const courtesy = await findCourtesy(req);
    if (!courtesy) return res.status(404).json({ success: false, message: "Cortesía no encontrada" });
    if (courtesy.status !== "completed") {
      return res.status(400).json({ success: false, message: "La cortesía está anulada: no hay entradas para enviar" });
    }
    if (Date.now() - (lastSend.get(courtesy.id) || 0) < SEND_COOLDOWN_MS) {
      return fail(courtesy, "cooldown", 429, "Ya se envió hace un momento. Esperá unos segundos antes de reenviar");
    }

    let sent;
    try {
      sent = await sendPurchaseEmail(courtesy.id);
    } catch (error) {
      console.error(`Error al enviar la cortesía ${courtesy.id}:`, error);
      return fail(courtesy, "send_error", 502, "No se pudo enviar el email. Probá de nuevo o copiá el link de las entradas");
    }
    if (!sent) {
      return fail(courtesy, "mail_not_configured", 503, "El envío de emails todavía no está configurado. Copiá el link y mandáselo a mano");
    }

    lastSend.set(courtesy.id, Date.now());
    await audit(req, { action: "COURTESY_SEND", entityType: "Purchase", entityId: courtesy.id, eventId: courtesy.eventId });
    res.json({ success: true, message: `Entradas enviadas a ${maskEmail(courtesy.buyerEmail)}` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Error al enviar la cortesía" });
  }
};

/**
 * @desc    Anular una cortesía: sus entradas que todavía no se usaron dejan de valer
 * @route   POST /api/courtesies/event/:eventId/:id/void
 * @access  Admin
 */
const voidCourtesy = async (req, res) => {
  try {
    const result = await sequelize.transaction(async (transaction) => {
      const purchase = await Purchase.findOne({
        where: { id: req.params.id, eventId: req.params.eventId, courtesy: true },
        lock: transaction.LOCK.UPDATE,
        transaction,
      });
      if (!purchase) return { notFound: true };
      if (purchase.status !== "completed") return { already: true };
      const voided = await voidPurchase(purchase, transaction);
      await audit(req, {
        action: "COURTESY_VOID",
        entityType: "Purchase",
        entityId: purchase.id,
        eventId: purchase.eventId,
        details: { ticketsVoided: voided.voided, ticketsAlreadyUsed: voided.used },
        transaction,
        strict: true,
      });
      return voided;
    });
    if (result.notFound) return res.status(404).json({ success: false, message: "Cortesía no encontrada" });
    if (result.already) return res.status(409).json({ success: false, message: "La cortesía ya estaba anulada" });
    res.json({ success: true, ticketsVoided: result.voided, ticketsAlreadyUsed: result.used });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Error al anular la cortesía" });
  }
};

module.exports = { listCourtesies, createCourtesy, updateCourtesy, sendCourtesy, voidCourtesy };
