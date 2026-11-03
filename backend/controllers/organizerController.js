const { UniqueConstraintError, ValidationError } = require("sequelize");
const Event = require("../models/Event");
const Purchase = require("../models/Purchase");
const PaymentAccount = require("../models/PaymentAccount");
const User = require("../models/User");
const { withLots } = require("../utils/lots");
const { present } = require("./paymentAccountController");
const { MIN_PASSWORD_LENGTH } = require("./userController");

// Panel del organizador. Todas las rutas con :eventId pasan antes por el middleware
// eventManager, que deja el evento en req.managedEvent solo si el usuario es el
// organizador de ESE evento (o admin): ninguna acción toca otro evento

const serverError = (res, error, message) => {
  console.error(error);
  res.status(500).json({
    success: false,
    message,
    error: process.env.NODE_ENV === "development" ? error.message : undefined,
  });
};

const presentStaff = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  eventId: user.eventId,
  createdAt: user.createdAt,
});

/**
 * @desc    Eventos del organizador (el admin ve todos)
 * @route   GET /api/organizer/events
 * @access  Organizador/Admin
 */
const getMyEvents = async (req, res) => {
  try {
    const where = req.user.role === "admin" ? {} : { organizerId: req.user.id };
    const events = await Event.findAll({ where, order: [["date", "DESC"]] });
    const result = await withLots(events);
    res.json({
      success: true,
      events: result.map((e, i) => ({ ...e, salesPaused: events[i].salesPaused })),
    });
  } catch (error) {
    serverError(res, error, "Error al obtener los eventos");
  }
};

// ---------- Staff del evento ----------

// Solo el staff de ESTE evento: nunca el general ni el de otro organizador
const findEventStaff = (event, id) =>
  User.findOne({ where: { id, role: "staff", eventId: event.id } });

/**
 * @desc    Staff creado para el evento (solo puede escanear ahí)
 * @route   GET /api/organizer/events/:eventId/staff
 */
const getStaff = async (req, res) => {
  try {
    const users = await User.findAll({
      where: { role: "staff", eventId: req.managedEvent.id },
      order: [["name", "ASC"]],
    });
    res.json({ success: true, users: users.map(presentStaff) });
  } catch (error) {
    serverError(res, error, "Error al obtener el staff");
  }
};

/**
 * @desc    Crear un staff para el evento
 * @route   POST /api/organizer/events/:eventId/staff
 * @body    { name, email, password }
 */
const createStaff = async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "Nombre, email y contraseña son obligatorios",
      });
    }
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        success: false,
        message: `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`,
      });
    }

    const user = await User.create({
      name: String(name).trim(),
      email: String(email).trim().toLowerCase(),
      password,
      role: "staff",
      eventId: req.managedEvent.id,
    });
    res.status(201).json({ success: true, user: presentStaff(user) });
  } catch (error) {
    if (error instanceof UniqueConstraintError) {
      return res.status(400).json({ success: false, message: "Ya existe un usuario con ese email" });
    }
    if (error instanceof ValidationError) {
      return res.status(400).json({ success: false, message: "El email no es válido" });
    }
    serverError(res, error, "Error al crear el staff");
  }
};

/**
 * @desc    Cambiar nombre o contraseña de un staff del evento
 * @route   PUT /api/organizer/events/:eventId/staff/:id
 */
const updateStaff = async (req, res) => {
  try {
    const user = await findEventStaff(req.managedEvent, req.params.id);
    if (!user) return res.status(404).json({ success: false, message: "Staff no encontrado" });

    const { name, password } = req.body;
    if (password !== undefined && (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH)) {
      return res.status(400).json({
        success: false,
        message: `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`,
      });
    }
    if (name) user.name = String(name).trim();
    if (password) user.password = password; // Se hashea en el hook beforeUpdate
    await user.save();
    res.json({ success: true, user: presentStaff(user) });
  } catch (error) {
    serverError(res, error, "Error al modificar el staff");
  }
};

/**
 * @desc    Borrar un staff del evento (su sesión deja de funcionar en el acto)
 * @route   DELETE /api/organizer/events/:eventId/staff/:id
 */
const deleteStaff = async (req, res) => {
  try {
    const user = await findEventStaff(req.managedEvent, req.params.id);
    if (!user) return res.status(404).json({ success: false, message: "Staff no encontrado" });
    await user.destroy();
    res.json({ success: true, message: "Staff eliminado" });
  } catch (error) {
    serverError(res, error, "Error al eliminar el staff");
  }
};

// ---------- Pagos del evento ----------

/**
 * @desc    Estado de los cobros del evento: cuentas propias, cuenta activa, pausa de ventas
 * @route   GET /api/organizer/events/:eventId/payments
 */
const getPayments = async (req, res) => {
  try {
    const event = req.managedEvent;
    const accounts = await PaymentAccount.findAll({
      where: { eventId: event.id },
      order: [["createdAt", "ASC"]],
    });
    res.json({
      success: true,
      event: { id: event.id, title: event.title },
      // "active" = la que cobra este evento ahora
      accounts: accounts.map((a) => ({ ...present(a), active: a.id === event.paymentAccountId })),
      usesOwnAccount: accounts.some((a) => a.id === event.paymentAccountId),
      salesPaused: event.salesPaused,
      pendingPurchases: await Purchase.count({ where: { eventId: event.id, status: "pending" } }),
      provider: process.env.PAYMENT_PROVIDER || "mock",
      keyConfigured: Boolean(process.env.PAYMENT_ACCOUNTS_KEY),
    });
  } catch (error) {
    serverError(res, error, "Error al obtener los pagos del evento");
  }
};

/**
 * @desc    Pausar o reanudar las ventas del evento
 * @route   PUT /api/organizer/events/:eventId/sales-paused
 * @body    { paused: boolean }
 */
const setSalesPaused = async (req, res) => {
  try {
    if (typeof req.body.paused !== "boolean") {
      return res.status(400).json({ success: false, message: "Indicá si las ventas están pausadas" });
    }
    await req.managedEvent.update({ salesPaused: req.body.paused });
    res.json({ success: true, salesPaused: req.body.paused });
  } catch (error) {
    serverError(res, error, "Error al cambiar el estado de las ventas");
  }
};

/**
 * @desc    Cobrar el evento con una de sus cuentas. Con las ventas del evento pausadas,
 *          así nadie compra a mitad del cambio
 * @route   POST /api/organizer/events/:eventId/payments/accounts/:id/activate
 */
const activateAccount = async (req, res) => {
  try {
    const event = req.managedEvent;
    if (!event.salesPaused) {
      return res.status(409).json({
        success: false,
        message: "Pausá las ventas del evento antes de cambiar la cuenta de cobro",
      });
    }
    const account = await PaymentAccount.findOne({ where: { id: req.params.id, eventId: event.id } });
    if (!account) return res.status(404).json({ success: false, message: "Cuenta no encontrada" });

    await event.update({ paymentAccountId: account.id });
    res.json({ success: true, account: { ...present(account), active: true } });
  } catch (error) {
    serverError(res, error, "Error al activar la cuenta");
  }
};

/**
 * @desc    Borrar una cuenta del evento que no es la activa ni cobró ninguna compra
 * @route   DELETE /api/organizer/events/:eventId/payments/accounts/:id
 */
const deleteAccount = async (req, res) => {
  try {
    const event = req.managedEvent;
    const account = await PaymentAccount.findOne({ where: { id: req.params.id, eventId: event.id } });
    if (!account) return res.status(404).json({ success: false, message: "Cuenta no encontrada" });

    if (event.paymentAccountId === account.id) {
      return res.status(409).json({ success: false, message: "No se puede borrar la cuenta activa" });
    }
    // Sus compras necesitan el token para confirmar los pagos
    if (await Purchase.count({ where: { paymentAccountId: account.id } })) {
      return res.status(409).json({
        success: false,
        message: "Esta cuenta ya cobró compras y su token hace falta para confirmar pagos",
      });
    }
    await account.destroy();
    res.json({ success: true });
  } catch (error) {
    serverError(res, error, "Error al borrar la cuenta");
  }
};

module.exports = {
  getMyEvents,
  getStaff,
  createStaff,
  updateStaff,
  deleteStaff,
  getPayments,
  setSalesPaused,
  activateAccount,
  deleteAccount,
};
