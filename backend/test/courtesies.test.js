// Cortesías: entradas que emite el admin sin pago, por evento. SQLite en memoria
process.env.DATABASE_URL = "sqlite::memory:";
process.env.JWT_SECRET = "test-secret";
process.env.NODE_ENV = "test";
process.env.RESEND_API_KEY = "re_test_key";
process.env.RESEND_FROM = "Tickets <tickets@test.com>";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

// Resend simulado: guarda lo que se enviaría; el resto de las llamadas pasa de largo
const realFetch = globalThis.fetch;
const emails = [];
globalThis.fetch = async (url, options = {}) => {
  if (String(url).includes("api.resend.com")) {
    emails.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return realFetch(url, options);
};

const app = require("../server");
const { sequelize } = require("../config/database");
const User = require("../models/User");
const Event = require("../models/Event");
const Lot = require("../models/Lot");
const Purchase = require("../models/Purchase");
const Ticket = require("../models/Ticket");
const StaffEvent = require("../models/StaffEvent");
const AuditLog = require("../models/AuditLog");

let server;
let baseUrl;
let admin;
let organizer;
let staff;
let event;
let other;
let lot;

const sign = (user) => jwt.sign({ id: user.id, v: user.tokenVersion }, process.env.JWT_SECRET);
const call = async (method, path, { user, body } = {}) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(user ? { Authorization: `Bearer ${sign(user)}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const asAdmin = (method, path, body) => call(method, path, { user: admin, body });
const create = (body, eventId = event.id) => asAdmin("POST", `/api/courtesies/event/${eventId}`, body);

before(async () => {
  await sequelize.sync({ force: true });
  admin = await User.create({ name: "Admin", email: "admin@test.com", password: "secret123", role: "admin" });
  organizer = await User.create({ name: "Org", email: "org@test.com", password: "secret123", role: "organizer" });
  staff = await User.create({ name: "Puerta", email: "puerta@test.com", password: "secret123", role: "staff" });
  const base = { description: "x", date: new Date(Date.now() + 86400000), location: "Club", userId: admin.id };
  event = await Event.create({ ...base, title: "Evento", organizerId: organizer.id });
  other = await Event.create({ ...base, title: "Otro" });
  lot = await Lot.create({ eventId: event.id, name: "General", price: 1000, quantity: 10, ticketsAvailable: 10 });
  await StaffEvent.create({ userId: staff.id, eventId: event.id });
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  globalThis.fetch = realFetch;
  server.close();
  await sequelize.close();
});

test("solo el admin genera y administra cortesías", async () => {
  const body = { name: "Ana", email: "ana@test.com" };
  assert.equal((await call("POST", `/api/courtesies/event/${event.id}`, { body })).status, 401);
  for (const user of [organizer, staff]) {
    assert.equal((await call("POST", `/api/courtesies/event/${event.id}`, { user, body })).status, 403);
    assert.equal((await call("GET", `/api/courtesies/event/${event.id}`, { user })).status, 403);
  }
  assert.equal(await Purchase.count(), 0);
});

test("valida nombre, email, cantidad y evento", async () => {
  for (const body of [
    { email: "ana@test.com" },
    { name: "Ana" },
    { name: "Ana", email: "no-es-un-mail" },
    { name: "Ana", email: "ana@test.com", quantity: 0 },
    { name: "Ana", email: "ana@test.com", quantity: 21 },
    { name: "Ana", email: "ana@test.com", quantity: 1.5 },
    { name: "Ana", email: "ana@test.com", quantity: "2" },
  ]) {
    assert.equal((await create(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await create({ name: "Ana", email: "ana@test.com" }, "00000000-0000-4000-8000-000000000000")).status, 404);
  assert.equal(await Purchase.count(), 0);
});

test("una cortesía crea una compra sin pago y una entrada por persona, sin tocar el cupo", async () => {
  const res = await create({ name: " Ana ", email: "ANA@test.com", quantity: 3 });
  assert.equal(res.status, 201);
  const c = res.body.courtesy;
  assert.equal(c.buyerName, "Ana");
  assert.equal(c.buyerEmail, "ana@test.com");
  assert.equal(c.Tickets.length, 3);
  assert.equal(new Set(c.Tickets.map((t) => t.code)).size, 3); // un código por entrada
  assert.ok(c.Tickets.every((t) => t.status === "valid"));

  const purchase = await Purchase.findByPk(c.id);
  assert.equal(purchase.courtesy, true);
  assert.equal(purchase.status, "completed");
  assert.equal(Number(purchase.totalPrice), 0);
  assert.equal(purchase.paymentGatewayId, null);
  assert.equal(purchase.paymentAccountId, null);
  assert.equal((await Lot.findByPk(lot.id)).ticketsAvailable, 10);
  assert.equal(emails.length, 0); // crear no manda el mail: eso lo hace el botón

  const list = await asAdmin("GET", `/api/courtesies/event/${event.id}`);
  assert.equal(list.body.courtesies.length, 1);
  assert.equal((await asAdmin("GET", `/api/courtesies/event/${other.id}`)).body.courtesies.length, 0); // por evento
});

test("enviar manda el mail con un QR por entrada, y reenviar tiene cooldown", async () => {
  const c = (await asAdmin("GET", `/api/courtesies/event/${event.id}`)).body.courtesies[0];
  const sent = await asAdmin("POST", `/api/courtesies/event/${event.id}/${c.id}/send`);
  assert.equal(sent.status, 200);
  assert.match(sent.body.message, /a\*\*\*@test\.com/); // email enmascarado
  assert.equal(emails.length, 1);
  assert.equal([].concat(emails[0].to)[0], "ana@test.com");
  assert.equal(emails[0].attachments.length, 3);
  for (const t of c.Tickets) assert.ok(emails[0].html.includes(t.code));

  assert.equal((await asAdmin("POST", `/api/courtesies/event/${event.id}/${c.id}/send`)).status, 429);
  assert.equal(emails.length, 1);
  // Desde otro evento no se encuentra
  assert.equal((await asAdmin("POST", `/api/courtesies/event/${other.id}/${c.id}/send`)).status, 404);
});

test("se puede corregir el mail y el nombre; no se aceptan datos inválidos", async () => {
  const c = (await asAdmin("GET", `/api/courtesies/event/${event.id}`)).body.courtesies[0];
  const url = `/api/courtesies/event/${event.id}/${c.id}`;
  assert.equal((await asAdmin("PUT", url, { email: "malo" })).status, 400);
  assert.equal((await asAdmin("PUT", url, {})).status, 400);
  const ok = await asAdmin("PUT", url, { email: "ana.nueva@test.com", name: "Ana María" });
  assert.equal(ok.status, 200);
  const stored = await Purchase.findByPk(c.id);
  assert.equal(stored.buyerEmail, "ana.nueva@test.com");
  assert.equal(stored.buyerName, "Ana María");
  assert.equal((await asAdmin("PUT", `/api/courtesies/event/${other.id}/${c.id}`, { name: "X" })).status, 404);
});

test("el escáner admite una cortesía igual que una entrada pagada, una sola vez", async () => {
  const [ticket] = await Ticket.findAll({ where: { eventId: event.id }, order: [["code", "ASC"]] });
  const sync = (scans) =>
    call("POST", `/api/checkin/events/${event.id}/sync`, { user: staff, body: { deviceId: "d1", scans } });
  const scan = (code) => ({ id: crypto.randomUUID(), code, scannedAt: new Date().toISOString() });

  const first = await sync([scan(ticket.code)]);
  assert.equal(first.body.results[0].result, "admitted");
  const again = await sync([scan(ticket.code)]);
  assert.equal(again.body.results[0].result, "duplicate");
  assert.equal((await Ticket.findByPk(ticket.id)).status, "used");

  // La lista del escáner no distingue cortesías: mismos campos que cualquier entrada
  const full = await sync([]);
  assert.ok(full.body.tickets.some((t) => t.code === ticket.code));
});

test("anular deja inválidas las entradas sin usar y no toca las que ya entraron", async () => {
  const c = (await asAdmin("GET", `/api/courtesies/event/${event.id}`)).body.courtesies[0];
  const res = await asAdmin("POST", `/api/courtesies/event/${event.id}/${c.id}/void`);
  assert.equal(res.status, 200);
  assert.equal(res.body.ticketsVoided, 2);
  assert.equal(res.body.ticketsAlreadyUsed, 1);
  const statuses = (await Ticket.findAll({ where: { purchaseId: c.id } })).map((t) => t.status).sort();
  assert.deepEqual(statuses, ["used", "void", "void"]);

  assert.equal((await asAdmin("POST", `/api/courtesies/event/${event.id}/${c.id}/void`)).status, 409);
  assert.equal((await asAdmin("POST", `/api/courtesies/event/${event.id}/${c.id}/send`)).status, 400);

  // Una entrada anulada ya no entra
  const [voided] = await Ticket.findAll({ where: { purchaseId: c.id, status: "void" } });
  const scan = { id: crypto.randomUUID(), code: voided.code, scannedAt: new Date().toISOString() };
  const synced = await call("POST", `/api/checkin/events/${event.id}/sync`, { user: staff, body: { deviceId: "d1", scans: [scan] } });
  assert.equal(synced.body.results[0].result, "void");
});

test("las acciones quedan auditadas sin el email del destinatario", async () => {
  const rows = await AuditLog.findAll({ order: [["createdAt", "ASC"]] });
  const actions = rows.map((r) => r.action);
  for (const a of ["COURTESY_CREATE", "COURTESY_SEND", "COURTESY_UPDATE", "COURTESY_VOID"]) {
    assert.ok(actions.includes(a), a);
  }
  const text = JSON.stringify(rows.map((r) => r.toJSON()));
  assert.ok(!text.includes("ana@test.com"));
  assert.ok(!text.includes("ana.nueva@test.com"));
});

test("no se generan cortesías para un evento cancelado", async () => {
  const cancelled = await Event.create({
    title: "Cancelado", description: "x", date: new Date(Date.now() + 86400000), location: "Club",
    userId: admin.id, status: "cancelled",
  });
  assert.equal((await create({ name: "Ana", email: "ana@test.com" }, cancelled.id)).status, 400);
});
