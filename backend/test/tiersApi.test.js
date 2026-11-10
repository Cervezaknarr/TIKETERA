// Tandas secuenciales (TT.05): API de extremo a extremo con SQLite en memoria.
// Complementa tiersUnit/tiersCheckout/tiersAdmin: no repite sus casos.
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
const Purchase = require("../models/Purchase");
const Ticket = require("../models/Ticket");
const { releaseExpiredPurchases } = require("../utils/purchases");

let server;
let baseUrl;
let adminToken;
let staffToken;
let organizerToken;
let n = 0;

const call = async (method, path, { body, token } = {}) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

// Cadena de 3 tandas (T2 y T3 con afterPrevious) (cupo 3 c/u) + VIP suelto
const newEvent = async (lots) => {
  const res = await call("POST", "/api/events", {
    token: adminToken,
    body: {
      title: "Fiesta",
      description: "Prueba",
      date: new Date(Date.now() + 86400000).toISOString(),
      location: "Club",
      status: "published",
      lots: lots || [
        { name: "T1", price: 1000, quantity: 3 },
        { name: "T2", price: 1300, quantity: 3, afterPrevious: true },
        { name: "T3", price: 1600, quantity: 3, afterPrevious: true },
        { name: "VIP", price: 5000, quantity: 3 },
      ],
    },
  });
  assert.equal(res.status, 201);
  const event = res.body.event;
  event.by = Object.fromEntries(event.lots.map((l) => [l.name, l.id]));
  return event;
};

const checkout = (event, lotName, quantity) =>
  call("POST", "/api/purchases/checkout", {
    body: {
      eventId: event.id,
      buyerName: "Ana Pérez",
      buyerEmail: `ana${++n}@test.com`,
      items: [{ lotId: event.by[lotName], quantity }],
    },
  });

const pay = (purchase) =>
  call("POST", "/api/purchases/webhook", { body: { paymentGatewayId: purchase.paymentGatewayId, status: "approved" } });

const buyAndPay = async (event, lotName, quantity) => {
  const res = await checkout(event, lotName, quantity);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal((await pay(res.body.purchase)).status, 200);
  return res.body.purchase;
};

const lockedMap = async (event, token) => {
  const res = await call("GET", `/api/events/${event.id}`, { token });
  return Object.fromEntries(res.body.event.lots.map((l) => [l.name, l.locked]));
};
const left = async (event, name) => (await Lot.findByPk(event.by[name])).ticketsAvailable;
const age = (purchase, minutes) =>
  Purchase.update({ createdAt: new Date(Date.now() - minutes * 60000) }, { where: { id: purchase.id }, silent: true });

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

test("GET /events/:id y GET /events marcan locked (3 tandas + VIP) y no filtran afterPrevious", async () => {
  const event = await newEvent();
  const expected = { T1: false, T2: true, T3: true, VIP: false };
  for (const token of [undefined, staffToken, organizerToken, adminToken]) {
    assert.deepEqual(await lockedMap(event, token), expected);
    const list = await call("GET", "/api/events", { token });
    const fromList = list.body.events.find((e) => e.id === event.id);
    assert.deepEqual(Object.fromEntries(fromList.lots.map((l) => [l.name, l.locked])), expected);
  }
  // Por slug también
  const bySlug = await call("GET", `/api/events/${event.slug}`);
  assert.equal(bySlug.body.event.lots.find((l) => l.name === "T2").locked, true);
  // Sin filtrar el cupo ni el precio de la bloqueada
  const t2 = bySlug.body.event.lots.find((l) => l.name === "T2");
  assert.equal(t2.ticketsAvailable, 3);
  assert.equal(t2.price, 1300);
  for (const token of [undefined, staffToken, organizerToken]) {
    const one = await call("GET", `/api/events/${event.id}`, { token });
    assert.ok(!JSON.stringify(one.body).includes("afterPrevious"));
    const list = await call("GET", "/api/events", { token });
    assert.ok(!JSON.stringify(list.body).includes("afterPrevious"));
  }
});

test("flujo completo: agotar T1 pagando habilita T2; T3 sigue bloqueada", async () => {
  const event = await newEvent();
  const p = await buyAndPay(event, "T1", 3);
  assert.equal(await Ticket.count({ where: { purchaseId: p.id } }), 3);
  assert.deepEqual(await lockedMap(event), { T1: false, T2: false, T3: true, VIP: false });

  await buyAndPay(event, "T2", 2);
  assert.equal(await left(event, "T2"), 1);
  assert.deepEqual(await lockedMap(event), { T1: false, T2: false, T3: true, VIP: false });
  const t3 = await checkout(event, "T3", 1);
  assert.equal(t3.status, 409);
  assert.equal(t3.body.code, "LOT_LOCKED");
  assert.equal(await left(event, "T3"), 3);

  // Agotar T2 también habilita T3
  await buyAndPay(event, "T2", 1);
  assert.deepEqual(await lockedMap(event), { T1: false, T2: false, T3: false, VIP: false });
  await buyAndPay(event, "T3", 1);
});

test("cupo liberado: al vencer la pendiente de T1, T2 se vuelve a bloquear y responde 409", async () => {
  const event = await newEvent();
  const pending = (await checkout(event, "T1", 3)).body.purchase; // T1 en 0 por pendiente
  assert.deepEqual(await lockedMap(event), { T1: false, T2: false, T3: true, VIP: false });
  const t2 = await buyAndPay(event, "T2", 1);

  await age(pending, 120);
  assert.equal(await releaseExpiredPurchases(), 1);
  assert.equal(await left(event, "T1"), 3);
  assert.deepEqual(await lockedMap(event), { T1: false, T2: true, T3: true, VIP: false });

  const res = await checkout(event, "T2", 1);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "LOT_LOCKED");
  assert.equal(await left(event, "T2"), 2);
  assert.equal((await Purchase.findByPk(t2.id)).status, "completed");
});

test("«Agotar» manual de T1 por la API habilita T2 y es comprable", async () => {
  const event = await newEvent();
  const res = await call("PUT", `/api/events/${event.id}/lots/${event.by.T1}`, {
    token: adminToken,
    body: { soldOut: true },
  });
  assert.equal(res.status, 200);
  assert.equal(await left(event, "T1"), 0);
  assert.deepEqual(await lockedMap(event), { T1: false, T2: false, T3: true, VIP: false });
  assert.equal((await checkout(event, "T2", 1)).status, 201);
  assert.equal((await checkout(event, "T3", 1)).status, 409);

  // Subir otra vez el cupo de T1 reabre T1 y bloquea T2
  await call("PUT", `/api/events/${event.id}/lots/${event.by.T1}`, { token: adminToken, body: { quantity: 5 } });
  assert.deepEqual(await lockedMap(event), { T1: false, T2: true, T3: true, VIP: false });
});

test("pago aprobado tardío de una compra de tanda ya bloqueada emite las entradas", async () => {
  const event = await newEvent();
  await Lot.update({ ticketsAvailable: 0 }, { where: { id: event.by.T1 } });
  const t2 = (await checkout(event, "T2", 2)).body.purchase;
  await age(t2, 120);
  assert.equal(await releaseExpiredPurchases(), 1);
  assert.equal(await left(event, "T2"), 3);
  // T1 recupera cupo: T2 queda bloqueada
  await Lot.update({ ticketsAvailable: 3 }, { where: { id: event.by.T1 } });
  assert.equal((await lockedMap(event)).T2, true);

  assert.equal((await pay(t2)).status, 200);
  assert.equal((await Purchase.findByPk(t2.id)).status, "completed");
  assert.equal(await Ticket.count({ where: { purchaseId: t2.id } }), 2);
  assert.equal(await left(event, "T2"), 1);
});

test("eventos sin afterPrevious: ningún lote bloqueado y se compra en cualquier orden", async () => {
  const event = await newEvent([
    { name: "A", price: 1000, quantity: 3 },
    { name: "B", price: 2000, quantity: 3 },
    { name: "C", price: 3000, quantity: 3, afterPrevious: false },
  ]);
  assert.deepEqual(await lockedMap(event), { A: false, B: false, C: false });
  assert.equal((await checkout(event, "C", 1)).status, 201);
  assert.equal((await checkout(event, "B", 1)).status, 201);
  const list = await call("GET", "/api/events");
  const fromList = list.body.events.find((e) => e.id === event.id);
  assert.ok(fromList.lots.every((l) => l.locked === false));
});

test("un lote paralelo en medio abre una cadena nueva (creado por la API)", async () => {
  const event = await newEvent([
    { name: "T1", price: 1000, quantity: 3 },
    { name: "T2", price: 1300, quantity: 3, afterPrevious: true },
    { name: "Otra", price: 900, quantity: 3 },
    { name: "Otra2", price: 950, quantity: 3, afterPrevious: true },
  ]);
  assert.deepEqual(await lockedMap(event), { T1: false, T2: true, Otra: false, Otra2: true });
  assert.equal((await checkout(event, "T2", 1)).body.code, "LOT_LOCKED");
  assert.equal((await checkout(event, "Otra", 1)).status, 201);
  assert.equal((await checkout(event, "Otra2", 1)).body.code, "LOT_LOCKED");
});

test("el primer lote del evento con afterPrevious es cabeza (se compra)", async () => {
  const event = await newEvent([
    { name: "P1", price: 1000, quantity: 3, afterPrevious: true },
    { name: "P2", price: 1300, quantity: 3, afterPrevious: true },
  ]);
  assert.deepEqual(await lockedMap(event), { P1: false, P2: true });
  assert.equal((await checkout(event, "P1", 1)).status, 201);
});

// SQLite en memoria usa una sola conexión y no admite transacciones simultáneas ("cannot start a
// transaction within a transaction", igual que se documenta en payments.test.js): la concurrencia
// real solo se puede probar con Postgres (TT.08). Aquí se verifican dos checkouts consecutivos
// sobre la tanda bloqueada y la consistencia del cupo.
test("dos checkouts seguidos sobre la tanda 2 bloqueada responden 409 y no reservan", async () => {
  const event = await newEvent();
  const a = await checkout(event, "T2", 1);
  const b = await checkout(event, "T2", 1);
  for (const r of [a, b]) {
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, "LOT_LOCKED");
  }
  assert.equal(await left(event, "T2"), 3);
  assert.equal(await Purchase.count({ where: { eventId: event.id } }), 0);
});
