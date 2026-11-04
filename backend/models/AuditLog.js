const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/database");

// Registro de auditoría de acciones de seguridad y de dinero (hallazgo H-02).
// APPEND-ONLY: solo se inserta. Nunca guardar contraseñas, tokens ni emails de
// compradores; el email de un login fallido va enmascarado (utils/redact.js: maskEmail)
// y en `details` van solo los campos que cambiaron.
//
// Retención: 1 año. La purga NO está automatizada: se hará con un procedimiento manual
// que deshabilita el trigger (ALTER TABLE "AuditLogs" DISABLE TRIGGER audit_log_append_only),
// borra lo vencido y lo vuelve a habilitar. Pendiente de la política T4.04.
//
// Capas de protección: (a) hooks de Sequelize que rechazan update/destroy; (b) en
// Postgres, un trigger que rechaza UPDATE y DELETE (ensureAppendOnlyTrigger, se llama
// después del sync al arrancar).
const AuditLog = sequelize.define("AuditLog", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  // Sin FK a propósito: borrar un usuario no debe borrar su auditoría
  actorId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  actorRole: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  // Ej.: LOGIN_OK, LOGIN_FAIL, USER_CREATE
  action: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  entityType: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  entityId: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  eventId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  result: {
    type: DataTypes.ENUM("success", "failure", "denied"),
    allowNull: false,
    defaultValue: "success",
  },
  ip: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  userAgent: {
    type: DataTypes.STRING(255),
    allowNull: true,
    set(value) {
      this.setDataValue("userAgent", value == null ? null : String(value).slice(0, 255));
    },
  },
  // Solo los campos que cambiaron, sin PII ni secretos
  details: {
    type: DataTypes.JSON,
    allowNull: true,
  },
}, {
  updatedAt: false,
  indexes: [
    { fields: ["createdAt"] },
    { fields: ["action"] },
    { fields: ["eventId"] },
  ],
});

const refuse = () => {
  throw new Error("AuditLog es append-only: no se puede modificar ni borrar");
};
AuditLog.beforeUpdate(refuse);
AuditLog.beforeDestroy(refuse);
AuditLog.beforeBulkUpdate(refuse);
AuditLog.beforeBulkDestroy(refuse);

// Crea (idempotente) el trigger que rechaza UPDATE y DELETE. Solo actúa en Postgres.
AuditLog.ensureAppendOnlyTrigger = async () => {
  if (sequelize.getDialect() !== "postgres") return false;
  const table = AuditLog.getTableName();
  const tableName = typeof table === "string" ? table : table.tableName;
  await sequelize.query(`
    CREATE OR REPLACE FUNCTION audit_log_block_changes() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'AuditLog es append-only: % no permitido', TG_OP;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await sequelize.query(`DROP TRIGGER IF EXISTS audit_log_append_only ON "${tableName}";`);
  await sequelize.query(`
    CREATE TRIGGER audit_log_append_only
    BEFORE UPDATE OR DELETE ON "${tableName}"
    FOR EACH ROW EXECUTE FUNCTION audit_log_block_changes();
  `);
  return true;
};

module.exports = AuditLog;
