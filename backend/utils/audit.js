const AuditLog = require("../models/AuditLog");

const RESULTS = ["success", "failure", "denied"];

/**
 * Registra una acción de seguridad o de dinero (hallazgo H-02): inserta en AuditLog y emite
 * UNA línea JSON a stdout (`{"audit":true,...}`) para el log stream. Nunca lanza: si la
 * escritura falla solo se loguea AUDIT_WRITE_FAILED, sin datos personales.
 * NUNCA pasar en `details` contraseñas, tokens ni emails de compradores.
 * @param {import("express").Request} req
 * @param {object} p
 * @param {string} p.action          Ej.: USER_CREATE
 * @param {string} [p.entityType]
 * @param {string} [p.entityId]
 * @param {string} [p.eventId]
 * @param {"success"|"failure"|"denied"} [p.result="success"]
 * @param {object} [p.details]       Solo campos que cambiaron, sin secretos
 * @param {{id?:string, role?:string}|null} [p.actor]  Por defecto req.user
 * @param {object} [p.transaction]   Transacción de Sequelize (opcional)
 * @returns {Promise<void>}
 */
const audit = async (req, { action, entityType, entityId, eventId, result, details, actor, transaction } = {}) => {
  try {
    const who = actor !== undefined ? actor : req && req.user;
    const row = {
      actorId: (who && who.id) || null,
      actorRole: (who && who.role) || null,
      action,
      entityType: entityType || null,
      entityId: entityId == null ? null : String(entityId),
      eventId: eventId || null,
      result: RESULTS.includes(result) ? result : "success",
      ip: (req && req.ip) || null,
      userAgent: (req && req.headers && req.headers["user-agent"]) || null,
      details: details && Object.keys(details).length ? details : null,
    };
    const created = await AuditLog.create(row, transaction ? { transaction } : undefined);
    console.log(
      JSON.stringify({
        audit: true,
        id: created.id,
        at: created.createdAt,
        action: row.action,
        result: row.result,
        actorId: row.actorId,
        actorRole: row.actorRole,
        entityType: row.entityType,
        entityId: row.entityId,
        eventId: row.eventId,
        ip: row.ip,
        details: row.details,
      })
    );
  } catch (error) {
    console.error(`AUDIT_WRITE_FAILED action=${action}`);
  }
};

module.exports = { audit };
