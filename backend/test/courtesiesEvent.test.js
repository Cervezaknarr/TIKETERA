// Toda cortesía (Purchase.courtesy = true) pertenece a un evento existente.
// SQLite en memoria. Cubre modelo, BD (NOT NULL / FK) y rutas.
process.env.DATABASE_URL = "sqlite::memory:";
process.env.JWT_SECRET = "test-secret";
process.env.NODE_ENV = "test";
process.env.RESEND_API_KEY = "re_test_key";
process.env.RESEND_FROM = "Tickets <tickets@test.com>";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const app = require("../server");
const { sequelize } = require("../config/database");
const User = require("../models/User");
const Event = require("../models/Event");
const Purchase = require("../models/Purchase");
const Ticket = require("../models/Ticket");

let server, baseUrl, admin, event, other;
const sign = (u) => jwt.sign({ id: u.id, v: u.tokenVersion }, process.env.JWT_SECRET);
const asAdmin = async (method, path, body) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${sign(admin)}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const valid = { name: "Ana", email: "ana@test.com", quantity: 1 };
const ghost = () => crypto.randomUUID();
const countCourtesies = () => Purchase.count({ where: { courtesy: true } });

before(async () => {
  await sequelize.sync({ force: true });
  admin = await User.create({ name: "Admin", email: "admin@test.com", password: "secret123", role: "admin" });
  const base = { description: "x", date: new Date(Date.now() + 86400000), location: "Club", userId: admin.id };
  event = await Event.create({ ...base, title: "Evento" });
  other = await Event.create({ ...base, title: "Otro" });
  await new Promise((r) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
});
after(async () => { await new Promise((r) => server.close(r)); await sequelize.close(); });

const pdata = (extra = {}) => ({ buyerName: "X", buyerEmail: "x@test.com", quantity: 1, totalPrice: 0, status: "completed", courtesy: true, ...extra });

test("modelo: eventId es NOT NULL con FK a Events", () => {
  const attr = Purchase.rawAttributes.eventId;
  assert.equal(attr.allowNull, false);
  const ref = attr.references.model;
  assert.equal(typeof ref === "string" ? ref : ref.tableName, Event.tableName);
  assert.equal(Purchase.rawAttributes.courtesy.allowNull, false);
});

test("modelo: no se crea una cortesía sin eventId ni con eventId null", async () => {
  await assert.rejects(Purchase.create(pdata()), /notNull|eventId/i);
  await assert.rejects(Purchase.create(pdata({ eventId: null })), /notNull|eventId/i);
  assert.equal(await countCourtesies(), 0);
});

test("BD: ni saltándose las validaciones de Sequelize entra una cortesía sin evento", async () => {
  await assert.rejects(Purchase.create(pdata({ eventId: null }), { validate: false }), /NOT NULL|constraint/i);
  assert.equal(await countCourtesies(), 0);
});

test("BD: una cortesía con evento inexistente es rechazada por la FK", async () => {
  await assert.rejects(Purchase.create(pdata({ eventId: ghost() }), { validate: false }), /FOREIGN KEY|constraint/i);
  assert.equal(await countCourtesies(), 0);
});

test("BD: no se puede borrar un evento que tiene cortesías (no quedan huérfanas)", async () => {
  const ev = await Event.create({ title: "Temp", description: "x", date: new Date(Date.now() + 86400000), location: "L", userId: admin.id });
  await Purchase.create(pdata({ eventId: ev.id }));
  let deleted = true;
  try { await ev.destroy(); } catch { deleted = false; }
  const orphans = await sequelize.query(
    "SELECT COUNT(*) AS n FROM Purchases p LEFT JOIN Events e ON e.id = p.eventId WHERE p.courtesy = 1 AND e.id IS NULL",
    { type: sequelize.QueryTypes.SELECT }
  );
  assert.equal(Number(orphans[0].n), 0, `huérfanas tras borrar el evento (borrado=${deleted})`);
});

test("API: crear cortesía con evento inexistente da 404 y no crea nada", async () => {
  const before = await Purchase.count();
  const r = await asAdmin("POST", `/api/courtesies/event/${ghost()}`, valid);
  assert.equal(r.status, 404);
  assert.equal(await Purchase.count(), before);
  assert.equal(await Ticket.count({ where: { eventId: null } }), 0);
});

test("API: eventId no UUID o ruta sin evento no crea cortesía", async () => {
  const before = await Purchase.count();
  for (const id of ["no-es-uuid", "undefined", "null", "0", "%20"]) {
    const r = await asAdmin("POST", `/api/courtesies/event/${id}`, valid);
    assert.ok([400, 404].includes(r.status), `eventId=${id} dio ${r.status}`);
  }
  assert.equal((await asAdmin("POST", `/api/courtesies/event`, valid)).status, 404); // sin :eventId no existe la ruta
  assert.equal((await asAdmin("POST", `/api/courtesies`, valid)).status, 404);
  assert.equal(await Purchase.count(), before);
});

test("API: un eventId en el body no mueve la cortesía a otro evento", async () => {
  const r = await asAdmin("POST", `/api/courtesies/event/${event.id}`, { ...valid, eventId: other.id, courtesy: false, totalPrice: 500 });
  assert.equal(r.status, 201);
  const p = await Purchase.findByPk(r.body.courtesy.id);
  assert.equal(p.eventId, event.id);
  assert.equal(p.courtesy, true);
  assert.equal(Number(p.totalPrice), 0);
  assert.equal((await Ticket.findAll({ where: { purchaseId: p.id } })).every((t) => t.eventId === event.id), true);
});

test("API: listar/editar/enviar/anular con evento inexistente da 404", async () => {
  const c = (await asAdmin("POST", `/api/courtesies/event/${event.id}`, valid)).body.courtesy;
  const g = ghost();
  assert.equal((await asAdmin("GET", `/api/courtesies/event/${g}`)).status, 404);
  for (const [m, s, b] of [["PUT", "", { name: "Z" }], ["POST", "/send"], ["POST", "/void"]]) {
    assert.equal((await asAdmin(m, `/api/courtesies/event/${g}/${c.id}${s}`, b)).status, 404, `${m}${s}`);
  }
  const p = await Purchase.findByPk(c.id);
  assert.equal(p.buyerName, "Ana");
  assert.equal(p.status, "completed");
});

test("API: una cortesía no es accesible desde otro evento (listar/editar/enviar/anular)", async () => {
  const c = (await asAdmin("POST", `/api/courtesies/event/${event.id}`, { ...valid, name: "Solo evento" })).body.courtesy;
  const list = await asAdmin("GET", `/api/courtesies/event/${other.id}`);
  assert.equal(list.status, 200);
  assert.ok(!list.body.courtesies.some((x) => x.id === c.id));
  for (const [m, s, b] of [["PUT", "", { name: "Z" }], ["POST", "/send"], ["POST", "/void"]]) {
    assert.equal((await asAdmin(m, `/api/courtesies/event/${other.id}/${c.id}${s}`, b)).status, 404, `${m}${s}`);
  }
  const p = await Purchase.findByPk(c.id);
  assert.equal(p.buyerName, "Solo evento");
  assert.equal(p.status, "completed");
  assert.equal(p.eventId, event.id);
});

test("API: invariante global, toda cortesía existente apunta a un evento existente", async () => {
  const all = await Purchase.findAll({ where: { courtesy: true } });
  assert.ok(all.length > 0);
  for (const p of all) assert.ok(p.eventId && (await Event.findByPk(p.eventId)), `cortesía ${p.id} sin evento`);
});
