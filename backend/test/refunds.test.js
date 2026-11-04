// Devoluciones y contracargos: la compra pasa a "refunded" y sus entradas dejan de servir
// en la puerta. También la anulación a mano desde el panel. SQLite en memoria
process.env.DATABASE_URL = "sqlite::memory:";
process.env.JWT_SECRET = "test-secret";
process.env.NODE_ENV = "test";
process.env.RESEND_API_KEY = ""; // Email inactivo

const crypto = require("crypto");
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");

const app = require("../server");
const { sequelize } = require("../config/database");
const User = require("../models/User");
const Event = require("../models/Event");
const Lot = require("../models/Lot");
const Purchase = require("../models/Purchase");
const Ticket = require("../models/Ticket");
const StaffEvent = require("../models/StaffEvent");

let server;
let baseUrl;
let admin;
let orgA;
let orgB;
let staff;
let event;
let lot;

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

// Una compra pagada de 2 entradas, con su pago en la pasarela simulada
const paidPurchase = async () => {
  const checkout = await call("POST", "/api/purchases/checkout", {
    body: {
      eventId: event.id,
      items: [{ lotId: lot.id, quantity: 2 }],
      buyerName: "Ana",
      buyerEmail: "ana@test.com",
    },
  });
  const { purchase } = checkout.body;
  await call("POST", "/api/purchases/webhook", {
    body: { paymentGatewayId: purchase.paymentGatewayId, status: "approved" },
  });
  return purchase;
};

const refundWebhook = (purchase) =>
  call("POST", "/api/purchases/webhook", {
    body: { paymentGatewayId: purchase.paymentGatewayId, status: "refunded" },
  });

const scan = async (code) => {
  const res = await call("POST", `/api/checkin/events/${event.id}/sync`, {
    user: staff,
    body: { deviceId: "puerta-1", scans: [{ id: crypto.randomUUID(), code, scannedAt: new Date().toISOString() }] },
  });
  return res.body.results[0].result;
};

before(async () => {
  await sequelize.sync({ force: true });
  admin = await User.create({ name: "Admin", email: "admin@test.com", password: "secret123", role: "admin" });
  orgA = await User.create({ name: "Org A", email: "orga@test.com", password: "secret123", role: "organizer" });
  orgB = await User.create({ name: "Org B", email: "orgb@test.com", password: "secret123", role: "organizer" });
  staff = await User.create({ name: "Puerta", email: "staff@test.com", password: "secret123", role: "staff" });
  event = await Event.create({
    title: "Fiesta",
    description: "x",
    date: new Date(Date.now() + 86400000),
    location: "Club",
    userId: admin.id,
    organizerId: orgA.id,
    status: "published",
  });
  lot = await Lot.create({ eventId: event.id, name: "General", price: 1000, quantity: 50, ticketsAvailable: 50 });
  await StaffEvent.create({ userId: staff.id, eventId: event.id });
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await sequelize.close();
});

test("una devolución o contracargo anula la compra y sus entradas dejan de servir", async () => {
  const purchase = await paidPurchase();
  const tickets = await Ticket.findAll({ where: { purchaseId: purchase.id } });
  assert.equal(tickets.length, 2);

  const hook = await refundWebhook(purchase);
  assert.equal(hook.status, 200);

  assert.equal((await Purchase.findByPk(purchase.id)).status, "refunded");
  const after = await Ticket.findAll({ where: { purchaseId: purchase.id } });
  assert.deepEqual(after.map((t) => t.status), ["void", "void"]);

  // En la puerta las rechaza
  assert.equal(await scan(tickets[0].code), "void");

  // Y el comprador ve que fueron anuladas
  const view = await call("GET", `/api/purchases/tickets/${purchase.accessToken}`);
  assert.equal(view.body.purchase.status, "refunded");
  assert.ok(view.body.tickets.every((t) => t.status === "void"));
});

test("si una entrada ya entró no se anula, el resto sí", async () => {
  const purchase = await paidPurchase();
  const [first, second] = await Ticket.findAll({
    where: { purchaseId: purchase.id },
    order: [["code", "ASC"]],
  });
  assert.equal(await scan(first.code), "admitted");

  await refundWebhook(purchase);

  assert.equal((await Ticket.findByPk(first.id)).status, "used");
  assert.equal((await Ticket.findByPk(second.id)).status, "void");
  assert.equal(await scan(second.code), "void");
});

test("un aviso de devolución repetido no cambia nada más", async () => {
  const purchase = await paidPurchase();
  await refundWebhook(purchase);
  const second = await refundWebhook(purchase);
  assert.equal(second.status, 200);
  assert.equal((await Purchase.findByPk(purchase.id)).status, "refunded");
  assert.equal(await Ticket.count({ where: { purchaseId: purchase.id, status: "void" } }), 2);
});

test("una devolución de una compra todavía pendiente la rechaza y libera el cupo", async () => {
  const left = async () => (await Lot.findByPk(lot.id)).ticketsAvailable;
  const before = await left();
  const checkout = await call("POST", "/api/purchases/checkout", {
    body: { eventId: event.id, items: [{ lotId: lot.id, quantity: 3 }], buyerName: "Luis", buyerEmail: "luis@test.com" },
  });
  assert.equal(await left(), before - 3);

  await refundWebhook(checkout.body.purchase);

  assert.equal((await Purchase.findByPk(checkout.body.purchase.id)).status, "failed");
  assert.equal(await left(), before);
});

test("el admin anula una compra a mano y el organizador solo las de su evento", async () => {
  const purchase = await paidPurchase();
  const path = (id = purchase.id, eventId = event.id) => `/api/purchases/event/${eventId}/${id}/void`;
  const reason = { reason: "Devolución hecha por fuera" };

  assert.equal((await call("POST", path())).status, 401);
  assert.equal((await call("POST", path(), { user: staff })).status, 403);
  assert.equal((await call("POST", path(), { user: orgB })).status, 403);

  const res = await call("POST", path(), { user: orgA, body: reason });
  assert.equal(res.status, 200);
  assert.match(res.body.message, /2 entrada\(s\) dejaron de ser válidas/);
  assert.match(res.body.message, /no devuelve el dinero/);
  assert.equal((await Purchase.findByPk(purchase.id)).status, "refunded");
  assert.equal(await Ticket.count({ where: { purchaseId: purchase.id, status: "void" } }), 2);

  // Ya anulada: no se puede anular dos veces
  const again = await call("POST", path(), { user: admin, body: reason });
  assert.equal(again.status, 400);
});

test("no se anula una compra pendiente ni una de otro evento", async () => {
  const other = await Event.create({
    title: "Otra", description: "x", date: new Date(Date.now() + 86400000),
    location: "Club", userId: admin.id, organizerId: orgB.id, status: "published",
  });
  const foreign = await Purchase.create({
    eventId: other.id, buyerName: "X", buyerEmail: "x@test.com", quantity: 1, totalPrice: 10, status: "completed",
  });
  const pending = await Purchase.create({
    eventId: event.id, buyerName: "Y", buyerEmail: "y@test.com", quantity: 1, totalPrice: 10, status: "pending",
  });

  const notPaid = await call("POST", `/api/purchases/event/${event.id}/${pending.id}/void`, { user: admin, body: { reason: "Prueba" } });
  assert.equal(notPaid.status, 400);
  // La compra de otro evento no se alcanza usando un evento propio en la URL
  const wrongEvent = await call("POST", `/api/purchases/event/${event.id}/${foreign.id}/void`, { user: orgA, body: { reason: "Prueba" } });
  assert.equal(wrongEvent.status, 404);
  assert.equal((await Purchase.findByPk(foreign.id)).status, "completed");
});

test("la anulación manual exige un motivo de 3 a 200 caracteres y lo guarda en la auditoría", async () => {
  const AuditLog = require("../models/AuditLog");
  const purchase = await paidPurchase();
  const url = `/api/purchases/event/${event.id}/${purchase.id}/void`;

  for (const body of [undefined, {}, { reason: "" }, { reason: "  ab  " }, { reason: 123 }, { reason: "x".repeat(201) }]) {
    const res = await call("POST", url, { user: orgA, body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.body.message, /motivo/);
  }
  assert.equal((await Purchase.findByPk(purchase.id)).status, "completed");

  const ok = await call("POST", url, { user: orgA, body: { reason: "  Cliente pidió devolución  " } });
  assert.equal(ok.status, 200);
  const row = await AuditLog.findOne({ where: { action: "PURCHASE_VOID", entityId: purchase.id } });
  assert.equal(row.details.reason, "Cliente pidió devolución");
});

test("si falla la auditoría estricta, la anulación manual se revierte y responde 500", async () => {
  const AuditLog = require("../models/AuditLog");
  const purchase = await paidPurchase();
  const original = AuditLog.create;
  AuditLog.create = async () => { throw new Error("audit caído"); };
  let res;
  try {
    res = await call("POST", `/api/purchases/event/${event.id}/${purchase.id}/void`, { user: orgA, body: { reason: "Prueba" } });
  } finally {
    AuditLog.create = original;
  }
  assert.equal(res.status, 500);
  assert.equal((await Purchase.findByPk(purchase.id)).status, "completed");
  assert.equal(await Ticket.count({ where: { purchaseId: purchase.id, status: "valid" } }), 2);
});
