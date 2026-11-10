// Tests de la API admin de tandas: afterPrevious en lotes y reorden (PUT /events/:id/lots-order)
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

let server;
let baseUrl;
let adminToken;
let staffToken;
let organizerToken;

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

const eventBody = (lots) => ({
  title: "Fiesta",
  description: "Prueba",
  date: new Date(Date.now() + 86400000).toISOString(),
  location: "Club",
  status: "published",
  lots,
});

const newEvent = async (lots) => {
  const { status, body } = await call("POST", "/api/events", { token: adminToken, body: eventBody(lots) });
  assert.equal(status, 201);
  return body.event;
};

const chain = () => [
  { name: "T1", price: 1000, quantity: 5 },
  { name: "T2", price: 2000, quantity: 5, afterPrevious: true },
  { name: "T3", price: 3000, quantity: 5, afterPrevious: true },
];

const ids = (event) => event.lots.map((l) => l.id);
const dbOrder = async (eventId) =>
  (await Lot.findAll({ where: { eventId }, order: [["position", "ASC"]] })).map((l) => l.name);

before(async () => {
  await sequelize.sync({ force: true });
  const mk = (name, role) => User.create({ name, email: `${name}@test.com`, password: "secret", role });
  const [admin, staff, organizer] = await Promise.all([mk("admin", "admin"), mk("staff", "staff"), mk("org", "organizer")]);
  const sign = (u) => jwt.sign({ id: u.id }, process.env.JWT_SECRET);
  adminToken = sign(admin);
  staffToken = sign(staff);
  organizerToken = sign(organizer);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await sequelize.close();
});

test("crear el evento guarda afterPrevious (ausente = false)", async () => {
  const event = await newEvent([
    { name: "A", price: 1, quantity: 5 },
    { name: "B", price: 1, quantity: 5, afterPrevious: true },
    { name: "C", price: 1, quantity: 5, afterPrevious: false },
  ]);
  const by = (n) => event.lots.find((l) => l.name === n);
  assert.equal(by("A").afterPrevious, false);
  assert.equal(by("B").afterPrevious, true);
  assert.equal(by("C").afterPrevious, false);
  assert.equal((await Lot.findByPk(by("B").id)).afterPrevious, true);
  assert.equal("tierGroup" in by("A"), false);
});

test("afterPrevious no booleano -> 400 (crear evento, alta y edición de lote)", async () => {
  for (const bad of ["true", 1, 0, null, "General", {}]) {
    const { status } = await call("POST", "/api/events", {
      token: adminToken,
      body: eventBody([{ name: "A", price: 1, quantity: 5, afterPrevious: bad }]),
    });
    assert.equal(status, 400, `crear evento con ${JSON.stringify(bad)}`);
  }
  const event = await newEvent([{ name: "Base", price: 1, quantity: 5 }]);
  const lotId = event.lots[0].id;
  for (const [method, path] of [
    ["POST", `/api/events/${event.id}/lots`],
    ["PUT", `/api/events/${event.id}/lots/${lotId}`],
  ]) {
    const res = await call(method, path, {
      token: adminToken,
      body: { name: "Otro", price: 1, quantity: 1, afterPrevious: "si" },
    });
    assert.equal(res.status, 400, `${method} con afterPrevious texto`);
  }
  assert.equal((await Lot.findByPk(lotId)).afterPrevious, false);
});

test("agregar y editar un lote: guarda, cambia y quita afterPrevious", async () => {
  const event = await newEvent([{ name: "Base", price: 1, quantity: 5 }]);
  const add = await call("POST", `/api/events/${event.id}/lots`, {
    token: adminToken,
    body: { name: "Nuevo", price: 10, quantity: 3, afterPrevious: true },
  });
  assert.equal(add.status, 201);
  assert.equal(add.body.lot.afterPrevious, true);

  const lotId = add.body.lot.id;
  // Editar otro campo no toca afterPrevious
  await call("PUT", `/api/events/${event.id}/lots/${lotId}`, { token: adminToken, body: { price: 11 } });
  assert.equal((await Lot.findByPk(lotId)).afterPrevious, true);

  const edit = await call("PUT", `/api/events/${event.id}/lots/${lotId}`, {
    token: adminToken,
    body: { afterPrevious: false },
  });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.lot.afterPrevious, false);
  assert.equal((await Lot.findByPk(lotId)).afterPrevious, false);

  const sinCampo = await call("POST", `/api/events/${event.id}/lots`, {
    token: adminToken,
    body: { name: "Otro", price: 10, quantity: 3 },
  });
  assert.equal(sinCampo.body.lot.afterPrevious, false);
});

test("reorden válido: cambia position, el orden devuelto y la tanda activa", async () => {
  const event = await newEvent(chain());
  const [t1, t2, t3] = ids(event);
  const res = await call("PUT", `/api/events/${event.id}/lots-order`, {
    token: adminToken,
    body: { order: [t2, t3, t1] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.deepEqual(res.body.event.lots.map((l) => l.name), ["T2", "T3", "T1"]);
  assert.deepEqual(res.body.event.lots.map((l) => l.position), [0, 1, 2]);
  assert.deepEqual(res.body.event.lots.map((l) => l.locked), [false, true, false]);
  assert.equal(res.body.event.lots[0].afterPrevious, true); // el admin lo ve (T2 conserva su flag)
  assert.deepEqual(await dbOrder(event.id), ["T2", "T3", "T1"]);

  const get = await call("GET", `/api/events/${event.id}`);
  assert.deepEqual(get.body.event.lots.map((l) => l.name), ["T2", "T3", "T1"]);
  assert.deepEqual(get.body.event.lots.map((l) => l.locked), [false, true, false]);
});

test("reorden inválido -> 400/404 y no cambia nada", async () => {
  const event = await newEvent(chain());
  const other = await newEvent([{ name: "Ajeno", price: 1, quantity: 5 }]);
  const [t1, t2, t3] = ids(event);
  const foreign = other.lots[0].id;
  const before = await dbOrder(event.id);
  const url = `/api/events/${event.id}/lots-order`;

  const bad = [
    [t1, t2], // falta uno
    [t1, t2, t3, foreign], // sobra uno ajeno
    [t1, t2, foreign], // uno es de otro evento
    [t1, t1, t2], // repetido
    [t1, t2, t3, t3], // sobra repetido
    [],
    "t1,t2,t3",
    [t1, t2, 5],
  ];
  for (const order of bad) {
    const res = await call("PUT", url, { token: adminToken, body: { order } });
    assert.equal(res.status, 400, JSON.stringify(order));
    assert.equal(res.body.success, false);
  }
  assert.equal((await call("PUT", url, { token: adminToken, body: {} })).status, 400);
  assert.deepEqual(await dbOrder(event.id), before);
  assert.deepEqual(await dbOrder(other.id), ["Ajeno"]);

  const missing = await call("PUT", "/api/events/00000000-0000-4000-8000-000000000000/lots-order", {
    token: adminToken,
    body: { order: [t1, t2, t3] },
  });
  assert.equal(missing.status, 404);
  assert.deepEqual(await dbOrder(event.id), before);
});

test("lots-order: sin sesión 401; staff y organizador 403", async () => {
  const event = await newEvent(chain());
  const order = ids(event).reverse();
  const url = `/api/events/${event.id}/lots-order`;
  assert.equal((await call("PUT", url, { body: { order } })).status, 401);
  assert.equal((await call("PUT", url, { token: staffToken, body: { order } })).status, 403);
  assert.equal((await call("PUT", url, { token: organizerToken, body: { order } })).status, 403);
  assert.deepEqual(await dbOrder(event.id), ["T1", "T2", "T3"]);
});

test("un no-admin nunca ve afterPrevious (público, staff y organizador)", async () => {
  const event = await newEvent(chain());
  const seen = async (token) => {
    const one = await call("GET", `/api/events/${event.id}`, { token });
    const list = await call("GET", "/api/events", { token });
    const fromList = list.body.events.find((e) => e.id === event.id);
    return [one.body.event, fromList].flatMap((e) => e.lots);
  };
  for (const token of [undefined, staffToken, organizerToken]) {
    const lots = await seen(token);
    assert.equal(lots.length, 6);
    for (const lot of lots) {
      assert.equal("afterPrevious" in lot, false);
      assert.equal(typeof lot.locked, "boolean");
    }
  }
  const asAdmin = await seen(adminToken);
  for (const lot of asAdmin) assert.equal(typeof lot.afterPrevious, "boolean");
});
