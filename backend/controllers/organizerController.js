const { UniqueConstraintError, ValidationError } = require("sequelize");
const Event = require("../models/Event");
const Purchase = require("../models/Purchase");
const PaymentAccount = require("../models/PaymentAccount");
const User = require("../models/User");
const StaffEvent = require("../models/StaffEvent");
const {
  assignmentsByUser,
  parseEventIds,
  setAssignments,
} = require("../utils/staffEvents");
const { withLots } = require("../utils/lots");
const { present } = require("./paymentAccountController");
const { MIN_PASSWORD_LENGTH } = require("./userController");
const { audit } = require("../utils/audit");
const { sequelize } = require("../config/database");

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

// `eventIds`: eventos del staff que quien consulta administra (no se filtran los ajenos)
const presentStaff = (user, eventIds) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  eventIds,
  createdAt: user.createdAt,
});

/** Eventos que el usuario administra: todos (null) para el admin, los suyos para el organizador */
const managedIds = async (user) => {
  if (user.role === "admin") return null;
  return (await Event.findAll({ where: { organizerId: user.id }, attributes: ["id"] })).map((e) => e.id);
};

const onlyManaged = (ids, managed) => (managed ? ids.filter((id) => managed.includes(id)) : ids);

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

// Solo el staff asignado a ESTE evento: nunca el de otros eventos
const findEventStaff = async (event, id) => {
  const assigned = await StaffEvent.findOne({ where: { userId: id, eventId: event.id } });
  return assigned ? User.findOne({ where: { id, role: "staff" } }) : null;
};

/**
 * El organizador solo toca el staff cuyos eventos son todos suyos: si además trabaja en
 * un evento de otro organizador, nombre, contraseña y baja los maneja el admin
 * @returns {Promise<string[]|null>} ids asignados, o null si no puede gestionarlo
 */
const manageableAssignments = async (user, staffUser) => {
  const ids = (await assignmentsByUser([staffUser.id]))[staffUser.id] || [];
  const managed = await managedIds(user);
  if (managed && ids.some((id) => !managed.includes(id))) return null;
  return ids;
};

const SHARED_STAFF_MESSAGE =
  "Este staff también trabaja en eventos de otro organizador: pedile al administrador el cambio";

/**
 * @desc    Staff asignado al evento (solo puede escanear en sus eventos)
 * @route   GET /api/organizer/events/:eventId/staff
 */
const getStaff = async (req, res) => {
  try {
    const rows = await StaffEvent.findAll({ where: { eventId: req.managedEvent.id } });
    const users = await User.findAll({
      where: { id: rows.map((r) => r.userId), role: "staff" },
      order: [["name", "ASC"]],
    });
    const assigned = await assignmentsByUser(users.map((u) => u.id));
    const managed = await managedIds(req.user);
    res.json({
      success: true,
      users: users.map((u) => presentStaff(u, onlyManaged(assigned[u.id] || [], managed))),
    });
  } catch (error) {
    serverError(res, error, "Error al obtener el staff");
  }
};

/**
 * @desc    Crear un staff para el evento. Con `eventIds` también queda asignado a otros
 *          eventos del organizador (el staff se repite entre sus eventos)
 * @route   POST /api/organizer/events/:eventId/staff
 * @body    { name, email, password, eventIds? }
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

    const managed = await managedIds(req.user);
    const requested = Array.isArray(req.body.eventIds) ? req.body.eventIds : [];
    const parsed = await parseEventIds([req.managedEvent.id, ...requested], { allowed: managed || undefined });
    if (parsed.error) {
      return res.status(parsed.forbidden ? 403 : 400).json({ success: false, message: parsed.error });
    }

    const user = await User.create({
      name: String(name).trim(),
      email: String(email).trim().toLowerCase(),
      password,
      role: "staff",
    });
    await setAssignments(user.id, parsed.ids);
    await audit(req, {
      action: "STAFF_CREATE",
      entityType: "User",
      entityId: user.id,
      eventId: req.managedEvent.id,
      details: { role: "staff", eventIds: parsed.ids },
    });
    res.status(201).json({ success: true, user: presentStaff(user, parsed.ids) });
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
 * @desc    Cambiar nombre, contraseña o eventos de un staff del evento
 * @route   PUT /api/organizer/events/:eventId/staff/:id
 * @body    { name?, password?, eventIds? }  eventIds = eventos del organizador donde trabaja
 */
const updateStaff = async (req, res) => {
  try {
    const user = await findEventStaff(req.managedEvent, req.params.id);
    if (!user) return res.status(404).json({ success: false, message: "Staff no encontrado" });
    const current = await manageableAssignments(req.user, user);
    if (!current) return res.status(403).json({ success: false, message: SHARED_STAFF_MESSAGE });

    const { name, password } = req.body;
    if (password !== undefined && (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH)) {
      return res.status(400).json({
        success: false,
        message: `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`,
      });
    }
    let eventIds = current;
    if (req.body.eventIds !== undefined) {
      const managed = await managedIds(req.user);
      const parsed = await parseEventIds(req.body.eventIds, { allowed: managed || undefined });
      if (parsed.error) {
        return res.status(parsed.forbidden ? 403 : 400).json({ success: false, message: parsed.error });
      }
      eventIds = parsed.ids;
    }
    const details = {};
    if (name && String(name).trim() !== user.name) details.name = { from: user.name, to: String(name).trim() };
    if (password) details.passwordChanged = true;
    if (req.body.eventIds !== undefined) {
      const same = eventIds.length === current.length && eventIds.every((id) => current.includes(id));
      if (!same) details.eventIds = { from: current, to: eventIds };
    }
    if (name) user.name = String(name).trim();
    if (password) user.password = password; // Se hashea en el hook beforeUpdate
    await user.save();
    if (req.body.eventIds !== undefined) await setAssignments(user.id, eventIds);
    await audit(req, {
      action: "STAFF_UPDATE",
      entityType: "User",
      entityId: user.id,
      eventId: req.managedEvent.id,
      details,
    });
    res.json({ success: true, user: presentStaff(user, eventIds) });
  } catch (error) {
    serverError(res, error, "Error al modificar el staff");
  }
};

/**
 * @desc    Sacar un staff del evento. Si no le quedan eventos se borra el usuario (su
 *          sesión deja de funcionar en el acto); si trabaja en otros, solo pierde este
 * @route   DELETE /api/organizer/events/:eventId/staff/:id
 */
const deleteStaff = async (req, res) => {
  try {
    const user = await findEventStaff(req.managedEvent, req.params.id);
    if (!user) return res.status(404).json({ success: false, message: "Staff no encontrado" });

    await StaffEvent.destroy({ where: { userId: user.id, eventId: req.managedEvent.id } });
    const left = await StaffEvent.count({ where: { userId: user.id } });
    if (!left) await user.destroy();
    await audit(req, {
      action: "STAFF_DELETE",
      entityType: "User",
      entityId: user.id,
      eventId: req.managedEvent.id,
      details: { removedFromEvent: true, userDeleted: !left },
    });
    res.json({ success: true, message: left ? "Staff quitado del evento" : "Staff eliminado" });
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
    const before = req.managedEvent.salesPaused;
    await req.managedEvent.update({ salesPaused: req.body.paused });
    await audit(req, {
      action: req.body.paused ? "SALES_PAUSE" : "SALES_RESUME",
      entityType: "Event",
      entityId: req.managedEvent.id,
      eventId: req.managedEvent.id,
      details: { salesPaused: { from: before, to: req.body.paused } },
    });
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

    const previous = event.paymentAccountId || null;
    await sequelize.transaction(async (transaction) => {
      await event.update({ paymentAccountId: account.id }, { transaction });
      await audit(req, {
        action: "PAYMENT_ACCOUNT_ACTIVATE",
        entityType: "PaymentAccount",
        entityId: account.id,
        eventId: event.id,
        details: { activeAccountId: { from: previous, to: account.id } },
        transaction,
        strict: true,
      });
    });
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
    await sequelize.transaction(async (transaction) => {
      await account.destroy({ transaction });
      await audit(req, {
        action: "PAYMENT_ACCOUNT_DELETE",
        entityType: "PaymentAccount",
        entityId: account.id,
        eventId: event.id,
        details: { name: account.name },
        transaction,
        strict: true,
      });
    });
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
