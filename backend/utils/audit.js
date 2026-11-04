const AuditLog = require("../models/AuditLog");

const RESULTS = ["success", "failure", "denied"];

// Línea JSON de stdout para el log stream (una por fila de auditoría)
const logLine = (created, row) =>
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

const buildRow = (req, { action, entityType, entityId, eventId, result, details, actor }) => {
  const who = actor !== undefined ? actor : req && req.user;
  return {
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
};

/**
 * Registra una acción de seguridad o de dinero (hallazgo H-02): inserta en AuditLog y emite
 * UNA línea JSON a stdout (`{"audit":true,...}`) para el log stream. Nunca lanza: si la
 * escritura falla solo se loguea AUDIT_WRITE_FAILED, sin datos personales.
 * Con `strict: true` (acciones de dinero y cuentas de cobro) el insert va DENTRO de `transaction`
 * y si falla se LANZA el error: la transacción hace rollback y la acción falla. La línea de
 * stdout se emite recién tras el commit (con rollback no sale). En ese modo
 * `transaction` es obligatorio.
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
 * @param {object} [p.transaction]   Transacción de Sequelize (opcional; obligatoria con strict)
 * @param {boolean} [p.strict=false] Lanzar si la escritura falla
 * @returns {Promise<void>}
 */
const audit = async (req, { transaction, strict, ...entry } = {}) => {
  const { action } = entry;
  if (strict && !transaction) throw new Error(`AUDIT_STRICT_REQUIRES_TRANSACTION action=${action}`);
  try {
    const row = buildRow(req, entry);
    const created = await AuditLog.create(row, transaction ? { transaction } : undefined);
    if (strict) transaction.afterCommit(() => logLine(created, row));
    else logLine(created, row);
  } catch (error) {
    if (strict) {
      console.error(`AUDIT_WRITE_FAILED action=${action} strict=true`);
      throw error;
    }
    console.error(`AUDIT_WRITE_FAILED action=${action}`);
  }
};

/**
 * Registra varias acciones con UN solo insert (check-in de alto volumen). No estricta: nunca
 * lanza. Debe llamarse sin una transacción abierta. Emite una línea de stdout por fila,
 * después del insert.
 * @param {import("express").Request} req
 * @param {object[]} entries  Mismos campos que audit() (sin transaction/strict)
 */
const auditBulk = async (req, entries) => {
  if (!entries || !entries.length) return;
  try {
    const rows = entries.map((entry) => buildRow(req, entry));
    const created = await AuditLog.bulkCreate(rows);
    created.forEach((c, i) => logLine(c, rows[i]));
  } catch (error) {
    console.error(`AUDIT_WRITE_FAILED action=${entries[0].action} bulk=${entries.length}`);
  }
};

module.exports = { audit, auditBulk };
