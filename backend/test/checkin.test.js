// Tests de emisión de entradas y control de acceso, con SQLite en memoria
process.env.DATABASE_URL = "sqlite::memory:";
process.env.JWT_SECRET = "test-secret";
process.env.NODE_ENV = "test";
process.env.RESEND_API_KEY = ""; // Email inactivo

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const app = require("../server");
const { sequelize } = require("../config/database");
const User = require("../models/User");
const Event = require("../models/Event");
const Purchase = require("../models/Purchase");
const Ticket = require("../models/Ticket");
const Scan = require("../models/Scan");
const {
  generateTicketCode,
  normalizeTicketCode,
} = require("../utils/ticketCode");

let server;
let baseUrl;
let event;
let staffToken;
let userToken;
let organizerToken;
let codes;
let accessToken;

const api = async (method, path, { token, body } = {}) => {
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

const sync = (deviceId, scans = [], since) =>
  api("POST", `/api/checkin/events/${event.id}/sync`, {
    token: staffToken,
    body: { deviceId, since, scans },
  });

const scan = (code) => ({
  id: crypto.randomUUID(),
  code,
  scannedAt: new Date().toISOString(),
});

before(async () => {
  await sequelize.sync({ force: true });

  // Organizador con rol "user": puede validar solo porque el evento es suyo
  const organizer = await User.create({
    name: "Organizador",
    email: "org@test.com",
    password: "secret",
  });
  const staffUser = await User.create({
    name: "Puerta 1",
    email: "staff@test.com",
    password: "secret",
    role: "staff",
  });
  const normalUser = await User.create({
    name: "Cliente",
    email: "cliente@test.com",
    password: "secret",
  });

  staffToken = jwt.sign({ id: staffUser.id }, process.env.JWT_SECRET);
  userToken = jwt.sign({ id: normalUser.id }, process.env.JWT_SECRET);
  organizerToken = jwt.sign({ id: organizer.id }, process.env.JWT_SECRET);

  event = await Event.create({
    title: "Fiesta",
    description: "Evento de prueba",
    date: new Date(Date.now() + 86400000),
    location: "Salón",
    ticketPrice: 1000,
    ticketsAvailable: 400,
    userId: organizer.id,
  });

  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await sequelize.close();
});

test("los códigos generados son válidos y se normalizan al tipearlos", () => {
  const code = generateTicketCode();
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  assert.equal(normalizeTicketCode(code.toLowerCase().replace("-", " ")), code);
  assert.equal(normalizeTicketCode("ABCDE-FGHOI"), "ABCDE-FGH01");
  assert.equal(normalizeTicketCode("ABC"), null);
  assert.equal(normalizeTicketCode("ABCDE-FGHIU"), null); // U no es válida
});

test("el webhook emite una entrada por persona y es idempotente", async () => {
  const checkout = await api("POST", "/api/purchases/checkout", {
    body: {
      eventId: event.id,
      buyerEmail: "juan@test.com",
      buyerName: "Juan",
      quantity: 3,
    },
  });
  assert.equal(checkout.status, 201);
  const { paymentGatewayId } = checkout.body.purchase;

  const first = await api("POST", "/api/purchases/webhook", {
    body: { paymentGatewayId, status: "approved" },
  });
  const second = await api("POST", "/api/purchases/webhook", {
    body: { paymentGatewayId, status: "approved" },
  });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.body.message, "Webhook ya procesado anteriormente");

  const tickets = await Ticket.findAll({ where: { eventId: event.id } });
  assert.equal(tickets.length, 3);
  assert.equal(new Set(tickets.map((t) => t.code)).size, 3);
  codes = tickets.map((t) => t.code);
  accessToken = checkout.body.purchase.accessToken;
});

test("el link privado de la compra muestra las entradas con su QR", async () => {
  const res = await api("GET", `/api/purchases/tickets/${accessToken}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.event.title, "Fiesta");
  assert.equal(res.body.tickets.length, 3);
  assert.deepEqual(
    res.body.tickets.map((t) => t.code).sort(),
    [...codes].sort()
  );
  assert.ok(res.body.tickets.every((t) => t.qr.startsWith("data:image/png;base64,")));

  const wrong = await api("GET", "/api/purchases/tickets/no-existe");
  assert.equal(wrong.status, 404);
});

test("un pago rechazado devuelve el cupo una sola vez", async () => {
  const before = (await Event.findByPk(event.id)).ticketsAvailable;
  const checkout = await api("POST", "/api/purchases/checkout", {
    body: {
      eventId: event.id,
      buyerEmail: "ana@test.com",
      buyerName: "Ana",
      quantity: 2,
    },
  });
  const { paymentGatewayId } = checkout.body.purchase;

  for (let i = 0; i < 2; i++) {
    await api("POST", "/api/purchases/webhook", {
      body: { paymentGatewayId, status: "rejected" },
    });
  }

  assert.equal((await Event.findByPk(event.id)).ticketsAvailable, before);
  const purchase = await Purchase.findOne({ where: { paymentGatewayId } });
  assert.equal(purchase.status, "failed");
  assert.equal(await Ticket.count({ where: { purchaseId: purchase.id } }), 0);
});

test("el organizador del evento puede validar entradas", async () => {
  const res = await api("POST", `/api/checkin/events/${event.id}/sync`, {
    token: organizerToken,
    body: { deviceId: "org", scans: [] },
  });
  assert.equal(res.status, 200);
});

test("solo staff, admin u organizador pueden sincronizar", async () => {
  const res = await api("POST", `/api/checkin/events/${event.id}/sync`, {
    token: userToken,
    body: { deviceId: "x", scans: [] },
  });
  assert.equal(res.status, 403);

  const noToken = await api("POST", `/api/checkin/events/${event.id}/sync`, {
    body: { deviceId: "x", scans: [] },
  });
  assert.equal(noToken.status, 401);
});

test("el primer sync descarga la lista completa de entradas", async () => {
  const res = await sync("device-A");
  assert.equal(res.status, 200);
  assert.equal(res.body.full, true);
  assert.equal(res.body.tickets.length, 3);
  assert.equal(res.body.tickets[0].buyerName, "Juan");
  assert.ok(res.body.tickets.every((t) => t.status === "valid"));
});

test("escanear admite una vez y reenviar el mismo escaneo no lo duplica", async () => {
  // Tipeado a mano: minúsculas y sin guión
  const typed = scan(codes[0].toLowerCase().replace("-", ""));

  const first = await sync("device-A", [typed]);
  assert.equal(first.body.results[0].result, "admitted");
  assert.equal(first.body.results[0].ticket.code, codes[0]);

  // Se cortó la conexión y el dispositivo reintenta el mismo escaneo
  const retry = await sync("device-A", [typed]);
  assert.equal(retry.body.results[0].result, "admitted");
  assert.equal(await Scan.count({ where: { id: typed.id } }), 1);
});

test("otro dispositivo que escanea la misma entrada recibe duplicado", async () => {
  const res = await sync("device-B", [scan(codes[0])]);
  const [result] = res.body.results;
  assert.equal(result.result, "duplicate");
  assert.equal(result.ticket.usedByDevice, "device-A");
  assert.ok(result.ticket.usedAt);
});

test("códigos inexistentes o mal formados son inválidos", async () => {
  const res = await sync("device-A", [scan("ZZZZZ-ZZZZZ"), scan("hola")]);
  assert.deepEqual(
    res.body.results.map((r) => r.result),
    ["invalid", "invalid"]
  );
});

test("escaneos offline en lote se procesan en orden", async () => {
  const res = await sync("device-B", [scan(codes[1]), scan(codes[1])]);
  assert.deepEqual(
    res.body.results.map((r) => r.result),
    ["admitted", "duplicate"]
  );
});

test("las entradas anuladas se rechazan", async () => {
  await Ticket.update({ status: "void" }, { where: { code: codes[2] } });
  const res = await sync("device-A", [scan(codes[2])]);
  assert.equal(res.body.results[0].result, "void");
});

test("el sync incremental devuelve lo que cambió desde la última vez", async () => {
  const base = await sync("device-C");
  const later = await sync("device-C", [], base.body.serverTime);
  assert.equal(later.body.full, false);
  // Todo cambió hace menos de un minuto (margen de solapamiento)
  assert.equal(later.body.tickets.length, 3);

  const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const none = await sync("device-C", [], future);
  assert.equal(none.body.tickets.length, 0);
});

test("datos de sync inválidos se rechazan", async () => {
  const noDevice = await api("POST", `/api/checkin/events/${event.id}/sync`, {
    token: staffToken,
    body: { scans: [] },
  });
  assert.equal(noDevice.status, 400);

  const badScan = await sync("device-A", [{ id: "1", code: "x" }]);
  assert.equal(badScan.status, 400);
});

test("el organizador lista las compras con sus entradas", async () => {
  const res = await api("GET", `/api/purchases/event/${event.id}`, {
    token: organizerToken,
  });
  assert.equal(res.status, 200);
  const juan = res.body.purchases.find((p) => p.buyerName === "Juan");
  assert.equal(juan.status, "completed");
  assert.equal(juan.Tickets.length, 3);
  assert.equal(juan.Tickets.filter((t) => t.status === "used").length, 2);
  const ana = res.body.purchases.find((p) => p.buyerName === "Ana");
  assert.equal(ana.status, "failed");
  assert.equal(ana.Tickets.length, 0);

  const other = await api("GET", `/api/purchases/event/${event.id}`, {
    token: userToken,
  });
  assert.equal(other.status, 403);
});

test("las estadísticas reflejan los ingresos", async () => {
  const res = await api("GET", `/api/checkin/events/${event.id}/stats`, {
    token: staffToken,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.stats, {
    total: 3,
    admitted: 2,
    pending: 0,
    void: 1,
    rejectedScans: 5,
  });
});
