const { Op } = require("sequelize");
const AuditLog = require("../models/AuditLog");

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const intParam = (value, fallback, { min, max }) => {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) return null;
  return Math.min(Math.max(n, min), max);
};

const parseDate = (value, endOfDay) => {
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const d = new Date(value.length === 10 && endOfDay ? `${value}T23:59:59.999Z` : value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * @desc    Consultar el registro de auditoría (más reciente primero)
 * @route   GET /api/audit
 * @access  Admin
 * @query   limit (1-200, def. 50), offset, action, actorId, eventId, from, to (ISO o AAAA-MM-DD)
 */
const getAuditLogs = async (req, res) => {
  try {
    const limit = intParam(req.query.limit, DEFAULT_LIMIT, { min: 1, max: MAX_LIMIT });
    const offset = intParam(req.query.offset, 0, { min: 0, max: Number.MAX_SAFE_INTEGER });
    if (limit === null || offset === null) {
      return res.status(400).json({ success: false, message: "limit y offset deben ser enteros" });
    }

    const where = {};
    for (const key of ["action", "actorId", "eventId"]) {
      const value = req.query[key];
      if (value === undefined || value === "") continue;
      if (typeof value !== "string") {
        return res.status(400).json({ success: false, message: `Filtro ${key} no válido` });
      }
      where[key] = value;
    }
    const range = {};
    if (req.query.from) {
      const from = typeof req.query.from === "string" ? parseDate(req.query.from, false) : null;
      if (!from) return res.status(400).json({ success: false, message: "from no es una fecha válida" });
      range[Op.gte] = from;
    }
    if (req.query.to) {
      const to = typeof req.query.to === "string" ? parseDate(req.query.to, true) : null;
      if (!to) return res.status(400).json({ success: false, message: "to no es una fecha válida" });
      range[Op.lte] = to;
    }
    if (Object.getOwnPropertySymbols(range).length) where.createdAt = range;

    const { rows, count } = await AuditLog.findAndCountAll({
      where,
      order: [["createdAt", "DESC"], ["id", "DESC"]],
      limit,
      offset,
    });
    res.json({ success: true, total: count, limit, offset, logs: rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Error al obtener la auditoría" });
  }
};

module.exports = { getAuditLogs };
