const Purchase = require("../models/Purchase");
const Event = require("../models/Event");
const Ticket = require("../models/Ticket");
const { v4: uuidv4 } = require("uuid");
const { sequelize } = require("../config/database");
const QRCode = require("qrcode");
const { generateTicketCode } = require("../utils/ticketCode");
const { sendTicketsEmail } = require("../utils/mailer");

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
 * @desc    Crear una sesión de pago (simulación de integración con pasarela de pago)
 * @route   POST /api/purchases/checkout
 * @access  Public
 */
const createCheckoutSession = async (req, res) => {
  const transaction = await sequelize.transaction();

  try {
    const { eventId, buyerEmail, buyerName, quantity } = req.body;

    // Verificar campos obligatorios
    if (!eventId || !buyerEmail || !buyerName || !quantity || quantity < 1) {
      return res.status(400).json({
        success: false,
        message: "Por favor proporciona todos los campos requeridos",
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

    // Verificar si hay suficientes entradas disponibles
    if (event.ticketsAvailable < quantity) {
      return res.status(400).json({
        success: false,
        message: `Solo quedan ${event.ticketsAvailable} entradas disponibles`,
      });
    }

    // Calcular el precio total
    const totalPrice = event.ticketPrice * quantity;

    // Generar un ID único para la transacción (simula el ID de la pasarela de pago)
    const paymentGatewayId = `mp_${uuidv4()}`;

    // Crear el registro de compra con estado 'pending'
    const purchase = await Purchase.create(
      {
        eventId,
        buyerEmail,
        buyerName,
        quantity,
        totalPrice,
        status: "pending",
        paymentGatewayId,
      },
      { transaction }
    );

    // Reducir el número de entradas disponibles
    event.ticketsAvailable -= quantity;
    await event.save({ transaction });

    // Confirmar la transacción
    await transaction.commit();

    // En un entorno real, aquí se integraría con Mercado Pago
    // Simularemos la URL de checkout
    const checkoutUrl = `https://ejemplo-checkout.com/pay/${paymentGatewayId}`;

    res.status(201).json({
      success: true,
      purchase: {
        id: purchase.id,
        eventId: purchase.eventId,
        buyerEmail: purchase.buyerEmail,
        quantity: purchase.quantity,
        totalPrice: purchase.totalPrice,
        status: purchase.status,
        paymentGatewayId: purchase.paymentGatewayId,
        accessToken: purchase.accessToken,
      },
      checkoutUrl,
    });
  } catch (error) {
    // Revertir la transacción en caso de error
    await transaction.rollback();

    console.error(error);
    res.status(500).json({
      success: false,
      message: "Error al crear la sesión de checkout",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

/**
 * @desc    Manejar el webhook de pago (simulación de respuesta de pasarela de pago)
 * @route   POST /api/purchases/webhook
 * @access  Public
 */
const handlePaymentWebhook = async (req, res) => {
  try {
    // En un entorno real, aquí verificaríamos la autenticidad del webhook
    // mediante firma o token que proporciona la pasarela de pago

    // Obtener datos del webhook (simulados por ahora)
    const { paymentGatewayId, status } = req.body;

    if (!paymentGatewayId || !status) {
      return res.status(400).json({
        success: false,
        message: "Datos del webhook incompletos",
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
      if (purchase.status !== "pending") return "already_processed";

      if (status === "approved") {
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
        await Event.increment("ticketsAvailable", {
          by: purchase.quantity,
          where: { id: purchase.eventId },
          transaction,
        });
      }

      return "processed";
    });

    if (result === "not_found") {
      return res.status(404).json({
        success: false,
        message: "Compra no encontrada",
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
        quantity: purchase.quantity,
        totalPrice: purchase.totalPrice,
        status: purchase.status,
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
