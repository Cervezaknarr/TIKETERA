const { Op } = require("sequelize");
const StaffEvent = require("../models/StaffEvent");
const Event = require("../models/Event");
const User = require("../models/User");

// Staff por evento: el único usuario general es el admin. Cada staff trabaja en los
// eventos donde fue asignado (uno o varios) y en ningún otro

/** Ids de los eventos donde el staff está asignado */
const eventIdsOfStaff = async (userId) =>
  (await StaffEvent.findAll({ where: { userId } })).map((a) => a.eventId);

/** ¿Está este staff asignado a este evento? */
const isAssigned = async (userId, eventId) =>
  !!(await StaffEvent.findOne({ where: { userId, eventId } }));

/** Ids de eventos por staff: { userId: [eventId, ...] } */
const assignmentsByUser = async (userIds) => {
  const map = {};
  if (!userIds.length) return map;
  const rows = await StaffEvent.findAll({ where: { userId: userIds } });
  for (const r of rows) (map[r.userId] = map[r.userId] || []).push(r.eventId);
  return map;
};

/**
 * Validar la lista de eventos que llega del cliente: array de ids únicos, todos de
 * eventos que existen. Devuelve { ids } o { error }. `allowed` limita a esos ids
 * (el organizador solo puede asignar eventos suyos)
 */
const parseEventIds = async (value, { allowed } = {}) => {
  if (!Array.isArray(value) || !value.length) {
    return { error: "Elegí al menos un evento para el staff" };
  }
  const ids = [...new Set(value.map(String))];
  if (ids.length > 100) return { error: "Demasiados eventos" };
  if (allowed && ids.some((id) => !allowed.includes(id))) {
    return { error: "Solo podés asignar eventos que administrás", forbidden: true };
  }
  const found = await Event.count({ where: { id: ids } }).catch(() => -1);
  if (found !== ids.length) return { error: "Alguno de los eventos no existe" };
  return { ids };
};

/** Reemplaza las asignaciones del staff por exactamente `eventIds` */
const setAssignments = async (userId, eventIds) => {
  await StaffEvent.destroy({ where: { userId, eventId: { [Op.notIn]: eventIds } } });
  for (const eventId of eventIds) {
    await StaffEvent.findOrCreate({ where: { userId, eventId } });
  }
};

/**
 * Migración al arrancar: el staff de un organizador tenía User.eventId; pasa a ser una
 * asignación. Después de pasarlo se limpia el campo (queda solo por compatibilidad)
 */
const migrateStaffEvents = async () => {
  const legacy = await User.findAll({ where: { role: "staff", eventId: { [Op.ne]: null } } });
  for (const user of legacy) {
    await StaffEvent.findOrCreate({ where: { userId: user.id, eventId: user.eventId } });
    user.eventId = null;
    await user.save({ hooks: false });
  }
  return legacy.length;
};

module.exports = {
  eventIdsOfStaff,
  isAssigned,
  assignmentsByUser,
  parseEventIds,
  setAssignments,
  migrateStaffEvents,
};
