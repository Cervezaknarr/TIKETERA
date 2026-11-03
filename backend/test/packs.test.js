// Tests de paquetes (promos por cantidad) con SQLite en memoria
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
const Pack = require("../models/Pack");
const PurchaseItem = require("../models/PurchaseItem");
const Ticket = require("../models/Ticket");
const { packUnitPrice } = require("../utils/packs");

let server;
let baseUrl;
let adminToken;
let owner;

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

const newEvent = async () => {
  const event = await Event.create({
    title: "Evento",
    description: "Prueba",
    date: new Date(Date.now() + 86400000),
    location: "Salón",
    userId: owner.id,
  });
  event.general = await Lot.create({
    eventId: event.id, name: "General", price: 1000, quantity: 50, ticketsAvailable: 50,
  });
  event.vip = await Lot.create({
    eventId: event.id, name: "VIP", price: 3000, quantity: 10, ticketsAvailable: 10,
  });
  event.pack5 = await Pack.create({
    eventId: event.id, lotId: event.general.id, quantity: 5, discountPercent: 5,
  });
  event.pack10 = await Pack.create({
    eventId: event.id, lotId: event.general.id, quantity: 10, discountPercent: 10,
  });
  return event;
};

const checkout = (event, body) =>
  call("POST", "/api/purchases/checkout", {
    body: { eventId: event.id, buyerName: "Ana Pérez", buyerEmail: "ana@test.com", ...body },
  });

const left = async (lot) => (await Lot.findByPk(lot.id)).ticketsAvailable;

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

test("un paquete de 5 con 5% cobra el precio con descuento y reserva 5 entradas", async () => {
  const event = await newEvent();
  const res = await checkout(event, { packs: [{ packId: event.pack5.id, count: 1 }] });

  assert.equal(res.status, 201);
  const { purchase } = res.body;
  assert.equal(purchase.quantity, 5);
  assert.equal(Number(purchase.totalPrice), 5 * 950);
  assert.equal(purchase.items.length, 1);
  assert.equal(purchase.items[0].packSize, 5);
  assert.equal(purchase.items[0].discountPercent, 5);
  assert.equal(Number(purchase.items[0].unitPrice), 950);
  assert.equal(await left(event.general), 45);
});

test("al pagar un paquete se generan tantas entradas como trae (2 paquetes de 5 = 10)", async () => {
  const event = await newEvent();
  const { body } = await checkout(event, { packs: [{ packId: event.pack5.id, count: 2 }] });
  assert.equal(Number(body.purchase.totalPrice), 10 * 950);

  const hook = await call("POST", "/api/purchases/webhook", {
    body: { paymentGatewayId: body.purchase.paymentGatewayId, status: "approved" },
  });
  assert.equal(hook.status, 200);
  const tickets = await Ticket.findAll({ where: { purchaseId: body.purchase.id } });
  assert.equal(tickets.length, 10);
  assert.equal(new Set(tickets.map((t) => t.code)).size, 10);
});

test("el paquete de 10 al 10% y se puede combinar un paquete con entradas sueltas", async () => {
  const event = await newEvent();
  const big = await checkout(event, { packs: [{ packId: event.pack10.id, count: 1 }] });
  assert.equal(big.status, 201);
  assert.equal(Number(big.body.purchase.totalPrice), 10 * 900);

  const mix = await checkout(event, {
    packs: [{ packId: event.pack5.id, count: 1 }],
    items: [{ lotId: event.vip.id, quantity: 2 }],
  });
  assert.equal(mix.status, 201);
  assert.equal(Number(mix.body.purchase.totalPrice), 5 * 950 + 2 * 3000);
  assert.equal(mix.body.purchase.items.length, 2);
});

test("un paquete y entradas sueltas del mismo lote son líneas separadas con su propio precio", async () => {
  const event = await newEvent();
  const res = await checkout(event, {
    packs: [{ packId: event.pack5.id, count: 1 }],
    items: [{ lotId: event.general.id, quantity: 2 }],
  });
  assert.equal(res.status, 201);
  assert.equal(Number(res.body.purchase.totalPrice), 5 * 950 + 2 * 1000);
  assert.equal(await left(event.general), 43);
  assert.equal(await PurchaseItem.count({ where: { purchaseId: res.body.purchase.id } }), 2);
});

test("el descuento lo define el servidor: no se puede mandar otro porcentaje ni cantidad", async () => {
  const event = await newEvent();
  const res = await checkout(event, {
    packs: [{ packId: event.pack5.id, count: 1, quantity: 1, discountPercent: 90, unitPrice: 1 }],
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.purchase.quantity, 5);
  assert.equal(Number(res.body.purchase.totalPrice), 5 * 950);
});

test("paquete inexistente, de otro evento o con datos inválidos se rechaza", async () => {
  const event = await newEvent();
  const other = await newEvent();

  for (const packs of [
    [{ packId: "no-existe", count: 1 }],
    [{ packId: other.pack5.id, count: 1 }],
    [{ packId: event.pack5.id, count: 0 }],
    [{ packId: event.pack5.id, count: 1.5 }],
    [{ count: 1 }],
  ]) {
    const res = await checkout(event, { packs });
    assert.equal(res.status, 400, JSON.stringify(packs));
  }
  assert.equal(await left(event.general), 50);
});

test("los paquetes cuentan para el tope de entradas por compra", async () => {
  const event = await newEvent();
  const res = await checkout(event, { packs: [{ packId: event.pack10.id, count: 2 }] });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /hasta 10 entradas/);
  assert.equal(await left(event.general), 50);
});

test("sin cupo suficiente el paquete no se vende y no deja cupo retenido", async () => {
  const event = await newEvent();
  await Lot.update({ ticketsAvailable: 4 }, { where: { id: event.general.id } });
  const res = await checkout(event, { packs: [{ packId: event.pack5.id, count: 1 }] });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /Solo quedan 4/);
  assert.equal(await left(event.general), 4);
});

test("el admin crea, edita y borra paquetes; el público los ve en el evento", async () => {
  const event = await newEvent();
  await Pack.destroy({ where: { eventId: event.id } });

  const created = await call("POST", `/api/events/${event.id}/packs`, {
    token: adminToken,
    body: { lotId: event.vip.id, quantity: 4, discountPercent: 7.5 },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.pack.discountPercent, 7.5);

  const pub = await call("GET", `/api/events/${event.id}`);
  assert.equal(pub.body.event.packs.length, 1);
  assert.equal(pub.body.event.packs[0].quantity, 4);
  assert.equal(pub.body.event.packs[0].lotId, event.vip.id);

  // Misma cantidad en el mismo lote: duplicado
  const dup = await call("POST", `/api/events/${event.id}/packs`, {
    token: adminToken,
    body: { lotId: event.vip.id, quantity: 4, discountPercent: 20 },
  });
  assert.equal(dup.status, 400);

  const edited = await call("PUT", `/api/events/${event.id}/packs/${created.body.pack.id}`, {
    token: adminToken,
    body: { discountPercent: 15 },
  });
  assert.equal(edited.body.pack.discountPercent, 15);
  assert.equal(edited.body.pack.quantity, 4);

  const removed = await call("DELETE", `/api/events/${event.id}/packs/${created.body.pack.id}`, {
    token: adminToken,
  });
  assert.equal(removed.status, 200);
  assert.equal((await call("GET", `/api/events/${event.id}`)).body.event.packs.length, 0);
});

test("validación de paquetes y permisos", async () => {
  const event = await newEvent();
  const other = await newEvent();
  const post = (body, token = adminToken) =>
    call("POST", `/api/events/${event.id}/packs`, { token, body });

  for (const body of [
    { lotId: event.vip.id, quantity: 1, discountPercent: 5 },
    { lotId: event.vip.id, quantity: 11, discountPercent: 5 },
    { lotId: event.vip.id, quantity: 3.5, discountPercent: 5 },
    { lotId: event.vip.id, quantity: 3, discountPercent: 0 },
    { lotId: event.vip.id, quantity: 3, discountPercent: 91 },
    { lotId: event.vip.id, quantity: 3, discountPercent: "abc" },
    { quantity: 3, discountPercent: 5 },
    { lotId: other.vip.id, quantity: 3, discountPercent: 5 }, // lote de otro evento
  ]) {
    assert.equal((await post(body)).status, 400, JSON.stringify(body));
  }
  // Sin sesión
  assert.equal((await post({ lotId: event.vip.id, quantity: 3, discountPercent: 5 }, null)).status, 401);
});

test("borrar un lote borra sus paquetes", async () => {
  const event = await newEvent();
  const res = await call("DELETE", `/api/events/${event.id}/lots/${event.general.id}`, {
    token: adminToken,
  });
  assert.equal(res.status, 200);
  assert.equal(await Pack.count({ where: { eventId: event.id } }), 0);
});

test("packUnitPrice redondea a centavos", () => {
  assert.equal(packUnitPrice(1000, 5), 950);
  assert.equal(packUnitPrice(1234.56, 5), 1172.83);
  assert.equal(packUnitPrice(3000, 7.5), 2775);
});
