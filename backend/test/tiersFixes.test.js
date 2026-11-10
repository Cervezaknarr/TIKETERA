// Correcciones de revisión de tandas: orden por id en withLots, reorden idempotente, lote inexistente.
// SQLite ignora FOR UPDATE: la concurrencia real (deadlocks) no se puede probar aquí
process.env.DATABASE_URL = "sqlite::memory:";
process.env.JWT_SECRET = "test-secret";
process.env.NODE_ENV = "test";
process.env.RESEND_API_KEY = "";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");

const app = require("../server");
const { sequelize } = require("../config/database");
const User = require("../models/User");
const Lot = require("../models/Lot");
const Event = require("../models/Event");
const { withLots } = require("../utils/lots");

let server;
let baseUrl;
let adminToken;

const call = async (method, path, { body, token } = {}) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

let ownerId;

before(async () => {
  await sequelize.sync({ force: true });
  const admin = await User.create({ name: "admin", email: "admin@test.com", password: "secret", role: "admin" });
  ownerId = admin.id;
  adminToken = jwt.sign({ id: admin.id }, process.env.JWT_SECRET);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await sequelize.close();
});

const newEvent = () =>
  Event.create({
    title: "Evento",
    description: "Prueba",
    date: new Date(Date.now() + 86400000),
    location: "Salón",
    userId: ownerId,
  });

test("withLots desempata por id cuando position y createdAt coinciden", async () => {
  const event = await newEvent();
  const createdAt = new Date();
  const mk = (id, name) =>
    Lot.create({ id, eventId: event.id, name, price: 1, quantity: 5, ticketsAvailable: 5, position: 0, createdAt });
  await mk("00000000-0000-4000-8000-00000000000b", "B");
  await mk("00000000-0000-4000-8000-00000000000a", "A");
  const out = await withLots(event, { admin: true });
  assert.deepEqual(out.lots.map((l) => l.name), ["A", "B"]);
});

test("reordenar con el mismo orden actual no cambia el resultado; con otro, sí", async () => {
  const event = await newEvent();
  const mk = (name, position) =>
    Lot.create({ eventId: event.id, name, price: 1, quantity: 5, ticketsAvailable: 5, position, afterPrevious: position > 0 });
  const a = await mk("A", 0);
  const b = await mk("B", 1);
  const c = await mk("C", 2);
  const url = `/api/events/${event.id}/lots-order`;
  const same = await call("PUT", url, { token: adminToken, body: { order: [a.id, b.id, c.id] } });
  assert.equal(same.status, 200);
  assert.deepEqual(same.body.event.lots.map((l) => l.name), ["A", "B", "C"]);
  const rev = await call("PUT", url, { token: adminToken, body: { order: [c.id, b.id, a.id] } });
  assert.equal(rev.status, 200);
  assert.deepEqual(rev.body.event.lots.map((l) => l.name), ["C", "B", "A"]);
  const bad = await call("PUT", url, { token: adminToken, body: { order: [c.id, b.id] } });
  assert.equal(bad.status, 400);
  assert.deepEqual((await withLots(event, { admin: true })).lots.map((l) => l.name), ["C", "B", "A"]);
});

test("checkout con un lote inexistente responde 400, no 500", async () => {
  const event = await newEvent();
  await Lot.create({ eventId: event.id, name: "A", price: 1, quantity: 5, ticketsAvailable: 5 });
  const res = await call("POST", "/api/purchases/checkout", {
    body: {
      eventId: event.id,
      buyerName: "Ana Pérez",
      buyerEmail: "ana@test.com",
      items: [{ lotId: "00000000-0000-4000-8000-0000000000ff", quantity: 1 }],
    },
  });
  assert.equal(res.status, 400);
});
