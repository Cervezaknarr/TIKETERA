// Tests de eventos para mayores de 18, con SQLite en memoria
process.env.DATABASE_URL = "sqlite::memory:";
process.env.JWT_SECRET = "test-secret";
process.env.NODE_ENV = "test";
process.env.RESEND_API_KEY = ""; // Email inactivo

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");

const app = require("../server");
const { sequelize } = require("../config/database");
const User = require("../models/User");
const Event = require("../models/Event");
const Lot = require("../models/Lot");

let server;
let baseUrl;
let owner;
let adminToken;

const call = async (method, path, { body, token } = {}) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

const newEvent = async (fields = {}) => {
  const event = await Event.create({
    title: "Evento",
    description: "Prueba",
    date: new Date(Date.now() + 86400000),
    location: "Club",
    userId: owner.id,
    ...fields,
  });
  event.general = await Lot.create({
    eventId: event.id,
    name: "General",
    price: 1000,
    quantity: 50,
    ticketsAvailable: 50,
  });
  return event;
};

const checkout = (event, items, extra = {}) =>
  call("POST", "/api/purchases/checkout", {
    body: { eventId: event.id, buyerName: "Ana", buyerEmail: "ana@test.com", items, ...extra },
  });

before(async () => {
  await sequelize.sync({ force: true });
  owner = await User.create({ name: "Org", email: "org@test.com", password: "secret", role: "admin" });
  adminToken = jwt.sign({ id: owner.id }, process.env.JWT_SECRET);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await sequelize.close();
});

test("el evento se puede crear como +18 desde la API", async () => {
  const res = await call("POST", "/api/events", {
    token: adminToken,
    body: {
      title: "Solo adultos",
      description: "x",
      date: new Date(Date.now() + 86400000).toISOString(),
      location: "Club",
      status: "published",
      adultsOnly: true,
      lots: [{ name: "General", price: 1000, quantity: 5 }],
    },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.event.adultsOnly, true);
});

test("un evento +18 se compra igual que los demás, sin aceptar nada", async () => {
  const adults = await newEvent({ adultsOnly: true });
  const res = await checkout(adults, [{ lotId: adults.general.id, quantity: 1 }]);
  assert.equal(res.status, 201);
});

test("el admin activa y desactiva +18; el público lo ve; un valor inválido se rechaza", async () => {
  const event = await newEvent();
  const on = await call("PUT", `/api/events/${event.id}`, { token: adminToken, body: { adultsOnly: true } });
  assert.equal(on.body.event.adultsOnly, true);
  assert.equal((await call("GET", `/api/events/${event.id}`)).body.event.adultsOnly, true);

  const bad = await call("PUT", `/api/events/${event.id}`, { token: adminToken, body: { adultsOnly: "si" } });
  assert.equal(bad.status, 400);

  const off = await call("PUT", `/api/events/${event.id}`, { token: adminToken, body: { adultsOnly: false } });
  assert.equal(off.body.event.adultsOnly, false);
});
