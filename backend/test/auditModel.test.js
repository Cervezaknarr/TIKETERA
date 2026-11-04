process.env.DATABASE_URL = "sqlite::memory:";
process.env.JWT_SECRET = "test-secret";
process.env.NODE_ENV = "test";

const { test, before } = require("node:test");
const assert = require("node:assert");
const { sequelize } = require("../config/database");
const AuditLog = require("../models/AuditLog");

before(async () => {
  await sequelize.sync({ force: true });
});

test("se puede crear una fila y el userAgent se recorta a 255", async () => {
  const row = await AuditLog.create({
    action: "LOGIN_FAIL",
    result: "failure",
    ip: "1.2.3.4",
    userAgent: "x".repeat(400),
    details: { email: "a***@dominio.com" },
  });
  assert.ok(row.id);
  assert.ok(row.createdAt);
  assert.strictEqual(row.userAgent.length, 255);
  assert.strictEqual(row.updatedAt, undefined);
});

test("update, destroy y sus versiones masivas lanzan error", async () => {
  const row = await AuditLog.create({ action: "USER_CREATE" });
  row.action = "OTRA";
  await assert.rejects(() => row.save(), /append-only/);
  await assert.rejects(() => row.destroy(), /append-only/);
  await assert.rejects(() => AuditLog.update({ action: "X" }, { where: {} }), /append-only/);
  await assert.rejects(() => AuditLog.destroy({ where: {} }), /append-only/);
  assert.strictEqual(await AuditLog.count({ where: { action: "USER_CREATE" } }), 1);
});

test("ensureAppendOnlyTrigger no hace nada fuera de Postgres", async () => {
  assert.strictEqual(await AuditLog.ensureAppendOnlyTrigger(), false);
});
