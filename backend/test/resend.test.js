// Reenvío del email de entradas desde el panel (admin u organizador del evento).
// Se intercepta el fetch a Resend para no enviar nada de verdad
process.env.DATABASE_URL = "sqlite::memory:";
process.env.JWT_SECRET = "test-secret";
process.env.NODE_ENV = "test";
process.env.RESEND_API_KEY = "re_test_key";
process.env.RESEND_FROM = "Ticketera <entradas@test.com>";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");

const realFetch = globalThis.fetch;
const emails = [];
let resendFails = false;
globalThis.fetch = async (url, options) => {
  if (!String(url).includes("api.resend.com")) return realFetch(url, options);
  if (resendFails) return new Response(JSON.stringify({ message: "boom" }), { status: 500 });
  emails.push(JSON.parse(options.body));
  return new Response(JSON.stringify({ id: "email_1" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const app = require("../server");
const { sequelize } = require("../config/database");
const User = require("../models/User");
const Event = require("../models/Event");
const Lot = require("../models/Lot");
const Purchase = require("../models/Purchase");
const Ticket = require("../models/Ticket");

let server;
let baseUrl;
let admin;
let orgA;
let orgB;
let eventA;
let eventB;

const sign = (user) => jwt.sign({ id: user.id, v: user.tokenVersion }, process.env.JWT_SECRET);
const resend = async (user, eventId, purchaseId) => {
  const res = await fetch(`${baseUrl}/api/purchases/event/${eventId}/${purchaseId}/resend`, {
    method: "POST",
    headers: user ? { Authorization: `Bearer ${sign(user)}` } : {},
  });
  return { status: res.status, body: await res.json() };
};

const newEvent = async (title, organizerId) => {
  const event = await Event.create({
    title,
    description: "x",
    date: new Date(Date.now() + 86400000),
    location: "Club",
    userId: admin.id,
    organizerId,
  });
  await Lot.create({ eventId: event.id, name: "General", price: 100, quantity: 10, ticketsAvailable: 10 });
  return event;
};

const newPurchase = async (event, status = "completed") => {
  const purchase = await Purchase.create({
    eventId: event.id,
    buyerName: "Ana",
    buyerEmail: "ana@test.com",
    quantity: 2,
    totalPrice: 200,
    status,
  });
  if (status === "completed") {
    await Ticket.bulkCreate([
      { eventId: event.id, purchaseId: purchase.id, code: `A${purchase.id.slice(0, 4)}-11111`.toUpperCase().slice(0, 11) },
      { eventId: event.id, purchaseId: purchase.id, code: `B${purchase.id.slice(0, 4)}-22222`.toUpperCase().slice(0, 11) },
    ]);
  }
  return purchase;
};

before(async () => {
  await sequelize.sync({ force: true });
  admin = await User.create({ name: "Admin", email: "admin@test.com", password: "secret123", role: "admin" });
  orgA = await User.create({ name: "Org A", email: "orga@test.com", password: "secret123", role: "organizer" });
  orgB = await User.create({ name: "Org B", email: "orgb@test.com", password: "secret123", role: "organizer" });
  eventA = await newEvent("Evento A", orgA.id);
  eventB = await newEvent("Evento B", orgB.id);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await sequelize.close();
});

test("el admin reenvía las entradas al email del comprador", async () => {
  const purchase = await newPurchase(eventA);
  const before = emails.length;
  const res = await resend(admin, eventA.id, purchase.id);

  assert.equal(res.status, 200);
  assert.match(res.body.message, /ana@test\.com/);
  assert.equal(emails.length, before + 1);
  assert.equal(emails.at(-1).to, "ana@test.com");
  assert.match(emails.at(-1).html, /\/#\/entradas\//);
  assert.equal(emails.at(-1).attachments.length, 2); // un QR por entrada
});

test("un reenvío seguido se frena para no llenar la bandeja del comprador", async () => {
  const purchase = await newPurchase(eventA);
  assert.equal((await resend(admin, eventA.id, purchase.id)).status, 200);
  const again = await resend(admin, eventA.id, purchase.id);
  assert.equal(again.status, 429);
  assert.match(again.body.message, /Esperá/);
});

test("el organizador solo reenvía compras de sus eventos", async () => {
  const mine = await newPurchase(eventA);
  const other = await newPurchase(eventB);

  assert.equal((await resend(orgA, eventA.id, mine.id)).status, 200);
  assert.equal((await resend(orgA, eventB.id, other.id)).status, 403);
  // La compra de otro evento tampoco se alcanza poniendo su id en un evento propio
  assert.equal((await resend(orgA, eventA.id, other.id)).status, 404);
});

test("sin sesión o sin permisos no se puede reenviar", async () => {
  const purchase = await newPurchase(eventA);
  assert.equal((await resend(null, eventA.id, purchase.id)).status, 401);

  const staff = await User.create({ name: "Staff", email: "staff@test.com", password: "secret123", role: "staff" });
  assert.equal((await resend(staff, eventA.id, purchase.id)).status, 403);
});

test("solo se reenvían compras pagas", async () => {
  const pending = await newPurchase(eventA, "pending");
  const res = await resend(admin, eventA.id, pending.id);
  assert.equal(res.status, 400);
  assert.match(res.body.message, /no está paga/);
});

test("si Resend falla, el panel recibe un error claro y no queda frenado", async () => {
  const purchase = await newPurchase(eventA);
  resendFails = true;
  try {
    const res = await resend(admin, eventA.id, purchase.id);
    assert.equal(res.status, 502);
    assert.match(res.body.message, /copiá el link/);
  } finally {
    resendFails = false;
  }
  // El fallo no cuenta como envío: se puede reintentar enseguida
  assert.equal((await resend(admin, eventA.id, purchase.id)).status, 200);
});
