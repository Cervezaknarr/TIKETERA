// Tests de compras con varios lotes (carrito), con SQLite en memoria
process.env.DATABASE_URL = "sqlite::memory:";
process.env.JWT_SECRET = "test-secret";
process.env.NODE_ENV = "test";
process.env.RESEND_API_KEY = ""; // Email inactivo

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const app = require("../server");
const { sequelize } = require("../config/database");
const User = require("../models/User");
const Event = require("../models/Event");
const Lot = require("../models/Lot");
const Purchase = require("../models/Purchase");
const PurchaseItem = require("../models/PurchaseItem");
const Ticket = require("../models/Ticket");
const { releaseExpiredPurchases } = require("../utils/purchases");

let server;
let baseUrl;
let owner;

const call = async (method, path, body) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
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
  const lot = (name, price, quantity) =>
    Lot.create({ eventId: event.id, name, price, quantity, ticketsAvailable: quantity });
  event.general = await lot("General", 1000, 50);
  event.vip = await lot("VIP", 3000, 10);
  return event;
};

const checkout = (event, items, extra = {}) =>
  call("POST", "/api/purchases/checkout", {
    eventId: event.id,
    buyerName: "Ana Pérez",
    buyerEmail: "ana@test.com",
    items,
    ...extra,
  });

const left = async (lot) => (await Lot.findByPk(lot.id)).ticketsAvailable;

before(async () => {
  await sequelize.sync({ force: true });
  owner = await User.create({ name: "Org", email: "org@test.com", password: "secret" });
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await sequelize.close();
});

test("una compra puede llevar varios lotes: reserva cada uno y suma el total", async () => {
  const event = await newEvent();
  const res = await checkout(event, [
    { lotId: event.general.id, quantity: 2 },
    { lotId: event.vip.id, quantity: 3 },
  ]);

  assert.equal(res.status, 201);
  const { purchase } = res.body;
  assert.equal(purchase.quantity, 5);
  assert.equal(Number(purchase.totalPrice), 2 * 1000 + 3 * 3000);
  assert.equal(purchase.items.length, 2);
  assert.match(purchase.lotName, /2× General/);
  assert.match(purchase.lotName, /3× VIP/);

  assert.equal(await left(event.general), 48);
  assert.equal(await left(event.vip), 7);
  assert.equal(await PurchaseItem.count({ where: { purchaseId: purchase.id } }), 2);
});

test("al pagar se emite una entrada por persona, cada una con su lote", async () => {
  const event = await newEvent();
  const { body } = await checkout(event, [
    { lotId: event.general.id, quantity: 2 },
    { lotId: event.vip.id, quantity: 1 },
  ]);
  const { purchase } = body;

  const hook = await call("POST", "/api/purchases/webhook", {
    paymentGatewayId: purchase.paymentGatewayId,
    status: "approved",
  });
  assert.equal(hook.status, 200);

  const tickets = await Ticket.findAll({ where: { purchaseId: purchase.id } });
  assert.equal(tickets.length, 3);
  const byLot = tickets.reduce((acc, t) => ({ ...acc, [t.lotName]: (acc[t.lotName] || 0) + 1 }), {});
  assert.deepEqual(byLot, { General: 2, VIP: 1 });

  const view = await call("GET", `/api/purchases/tickets/${purchase.accessToken}`);
  assert.equal(view.body.purchase.items.length, 2);
  assert.deepEqual(view.body.tickets.map((t) => t.lotName).sort(), ["General", "General", "VIP"]);

  // Un webhook repetido no emite entradas de más
  await call("POST", "/api/purchases/webhook", {
    paymentGatewayId: purchase.paymentGatewayId,
    status: "approved",
  });
  assert.equal(await Ticket.count({ where: { purchaseId: purchase.id } }), 3);
});

test("si un lote no alcanza, no se reserva ninguno", async () => {
  const event = await newEvent();
  await Lot.update({ ticketsAvailable: 1 }, { where: { id: event.vip.id } });

  const res = await checkout(event, [
    { lotId: event.general.id, quantity: 2 },
    { lotId: event.vip.id, quantity: 3 },
  ]);

  assert.equal(res.status, 400);
  assert.match(res.body.message, /Solo quedan 1 entradas disponibles en VIP/);
  assert.equal(await left(event.general), 50);
  assert.equal(await left(event.vip), 1);
  assert.equal(await Purchase.count({ where: { eventId: event.id } }), 0);
});

test("el tope por compra cuenta todas las entradas del carrito", async () => {
  const event = await newEvent();
  const res = await checkout(event, [
    { lotId: event.general.id, quantity: 6 },
    { lotId: event.vip.id, quantity: 5 },
  ]);
  assert.equal(res.status, 400);
  assert.match(res.body.message, /hasta 10 entradas por compra/);
  assert.equal(await left(event.general), 50);
});

test("un lote repetido se suma y uno ajeno se rechaza", async () => {
  const event = await newEvent();
  const other = await newEvent();

  const merged = await checkout(event, [
    { lotId: event.general.id, quantity: 1 },
    { lotId: event.general.id, quantity: 2 },
  ]);
  assert.equal(merged.status, 201);
  assert.equal(merged.body.purchase.items.length, 1);
  assert.equal(merged.body.purchase.quantity, 3);

  const foreign = await checkout(event, [{ lotId: other.general.id, quantity: 1 }]);
  assert.equal(foreign.status, 400);
  assert.match(foreign.body.message, /no pertenece/);

  assert.equal((await checkout(event, [])).status, 400);
  assert.equal((await checkout(event, [{ lotId: event.general.id, quantity: 0 }])).status, 400);
});

test("el formato anterior (un lote y cantidad) sigue funcionando", async () => {
  const event = await newEvent();
  const res = await call("POST", "/api/purchases/checkout", {
    eventId: event.id,
    lotId: event.vip.id,
    quantity: 2,
    buyerName: "Ana",
    buyerEmail: "ana@test.com",
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.purchase.lotName, "VIP");
  assert.equal(await left(event.vip), 8);
});

test("un pago rechazado o una compra vencida devuelven el cupo de todos los lotes", async () => {
  const event = await newEvent();
  const rejected = await checkout(event, [
    { lotId: event.general.id, quantity: 2 },
    { lotId: event.vip.id, quantity: 2 },
  ]);
  await call("POST", "/api/purchases/webhook", {
    paymentGatewayId: rejected.body.purchase.paymentGatewayId,
    status: "rejected",
  });
  assert.equal(await left(event.general), 50);
  assert.equal(await left(event.vip), 10);

  const abandoned = await checkout(event, [
    { lotId: event.general.id, quantity: 4 },
    { lotId: event.vip.id, quantity: 1 },
  ]);
  assert.equal(await left(event.general), 46);
  await Purchase.update(
    { createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    { where: { id: abandoned.body.purchase.id } }
  );
  assert.equal(await releaseExpiredPurchases(), 1);
  assert.equal(await left(event.general), 50);
  assert.equal(await left(event.vip), 10);
});

test("un pago aprobado tarde con un lote agotado no reserva nada a medias", async () => {
  const event = await newEvent();
  const { body } = await checkout(event, [
    { lotId: event.general.id, quantity: 2 },
    { lotId: event.vip.id, quantity: 2 },
  ]);
  const { purchase } = body;

  // La compra vence y se libera; después el VIP se agota y recién ahí llega el pago
  await Purchase.update(
    { createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    { where: { id: purchase.id } }
  );
  await releaseExpiredPurchases();
  await Lot.update({ ticketsAvailable: 0 }, { where: { id: event.vip.id } });

  const hook = await call("POST", "/api/purchases/webhook", {
    paymentGatewayId: purchase.paymentGatewayId,
    status: "approved",
  });
  assert.equal(hook.status, 200);
  assert.match(hook.body.message, /requiere reembolso/);

  // El General (que sí alcanzaba) no quedó retenido y no se emitió ninguna entrada
  assert.equal(await left(event.general), 50);
  assert.equal(await Ticket.count({ where: { purchaseId: purchase.id } }), 0);
});
