// Ubicación del evento: el admin elige qué se busca en el mapa de la página (mapQuery). SQLite en memoria
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

let server;
let baseUrl;
let admin;

const sign = (user) => jwt.sign({ id: user.id, v: user.tokenVersion }, process.env.JWT_SECRET);
const call = async (method, path, { user, body } = {}) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(user ? { Authorization: `Bearer ${sign(user)}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

const create = (title, extra = {}) =>
  call("POST", "/api/events", {
    user: admin,
    body: {
      title,
      description: "x",
      date: new Date(Date.now() + 86400000).toISOString(),
      location: "Club",
      status: "published",
      lots: [{ name: "General", price: 1000, quantity: 10 }],
      ...extra,
    },
  });

before(async () => {
  await sequelize.sync({ force: true });
  admin = await User.create({ name: "Admin", email: "admin@test.com", password: "secret123", role: "admin" });
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  server.close();
  await sequelize.close();
});

test("el mapa del evento: se elige al crear, se edita y se puede quitar", async () => {
  const made = await create("Con mapa", { mapQuery: "  Av. 1 y 60, La Plata " });
  assert.equal(made.status, 201);
  assert.equal(made.body.event.mapQuery, "Av. 1 y 60, La Plata");
  const id = made.body.event.id;

  // Es público: la página del evento lo necesita para armar el mapa
  const pub = await call("GET", `/api/events/${id}`);
  assert.equal(pub.body.event.mapQuery, "Av. 1 y 60, La Plata");

  const edited = await call("PUT", `/api/events/${id}`, { user: admin, body: { mapQuery: "Teatro Argentino" } });
  assert.equal(edited.body.event.mapQuery, "Teatro Argentino");

  // Sin tocar el campo, se conserva
  const other = await call("PUT", `/api/events/${id}`, { user: admin, body: { title: "Con mapa 2" } });
  assert.equal(other.body.event.mapQuery, "Teatro Argentino");

  // Vacío lo quita: el mapa vuelve a buscar por el lugar
  const cleared = await call("PUT", `/api/events/${id}`, { user: admin, body: { mapQuery: "  " } });
  assert.equal(cleared.body.event.mapQuery, null);
});

test("el mapa del evento es opcional y se valida", async () => {
  const plain = await create("Sin mapa");
  assert.equal(plain.status, 201);
  assert.equal(plain.body.event.mapQuery, null);

  const long = await create("Mapa largo", { mapQuery: "x".repeat(201) });
  assert.equal(long.status, 400);
  const bad = await create("Mapa raro", { mapQuery: 123 });
  assert.equal(bad.status, 400);
});
