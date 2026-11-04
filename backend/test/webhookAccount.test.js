// H-01: el webhook solo confirma/anula una compra si la cuenta de la URL (?acc=) es la de la compra
process.env.DATABASE_URL = "sqlite::memory:";
process.env.JWT_SECRET = "test-secret";
process.env.NODE_ENV = "test";
process.env.RESEND_API_KEY = ""; // Email inactivo
process.env.PAYMENT_ACCOUNTS_KEY = "clave-de-prueba-para-cifrar";
process.env.PAYMENT_PROVIDER = "mercadopago";
process.env.MERCADOPAGO_ACCESS_TOKEN = "ENV-token-del-entorno-0000";
process.env.BACKEND_URL = "https://api.ticketera.test";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const app = require("../server");
const { sequelize } = require("../config/database");
const User = require("../models/User");
const Event = require("../models/Event");
const Lot = require("../models/Lot");
const Purchase = require("../models/Purchase");
const Ticket = require("../models/Ticket");
const PaymentAccount = require("../models/PaymentAccount");
const { encrypt } = require("../utils/secrets");

const TOKEN_A = "APP_USR-cuenta-a-1111111111";
const TOKEN_B = "APP_USR-cuenta-b-2222222222";
const BUYER_EMAIL = "victima.secreta@test.com";

let server;
let baseUrl;
let event;
let accountA;
let accountB;
let seq = 0;

// API de Mercado Pago simulada: el resto de las llamadas (al propio servidor) pasa de largo
const realFetch = globalThis.fetch;
let mpHandler;

const webhook = (acc) =>
  fetch(`${baseUrl}/api/purchases/webhook?type=payment&data.id=123456${acc ? `&acc=${acc}` : ""}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));

// Mercado Pago responde que el pago 123456 referencia a esta compra con ese estado y monto
const payment = (gatewayId, status, amount = 1000) => {
  mpHandler = () => ({
    body: { status, external_reference: gatewayId, transaction_amount: amount, currency_id: "ARS" },
  });
};

// Compra en la base, como la deja el checkout (paymentAccountId = cuenta con la que se creó el pago)
const makePurchase = async ({ paymentAccountId = null, status = "pending", withTickets = false } = {}) => {
  seq += 1;
  const purchase = await Purchase.create({
    eventId: event.id,
    lotId: event.lot.id,
    lotName: "General",
    unitPrice: 1000,
    buyerEmail: BUYER_EMAIL,
    buyerName: "Comprador",
    quantity: 1,
    totalPrice: 1000,
    status,
    paymentGatewayId: `compra-wh-${seq}`,
    paymentAccountId,
  });
  if (withTickets) {
    await Ticket.create({
      eventId: event.id,
      purchaseId: purchase.id,
      lotId: event.lot.id,
      lotName: "General",
      code: `WH${String(seq).padStart(5, "0")}`,
    });
  }
  return purchase;
};

const state = async (purchase) => ({
  status: (await Purchase.findByPk(purchase.id)).status,
  tickets: await Ticket.count({ where: { purchaseId: purchase.id } }),
});

// Captura console.error / warn / log mientras corre `fn`
const captureLogs = async (fn) => {
  const original = { error: console.error, warn: console.warn, log: console.log };
  const lines = [];
  const grab = (...args) => lines.push(args.map(String).join(" "));
  console.error = grab;
  console.warn = grab;
  console.log = grab;
  try {
    return { result: await fn(), logs: lines.join("\n") };
  } finally {
    Object.assign(console, original);
  }
};

before(async () => {
  await sequelize.sync({ force: true });
  const adminUser = await User.create({ name: "Admin", email: "admin@test.com", password: "secret123", role: "admin" });
  event = await Event.create({
    title: "Evento",
    description: "Prueba",
    date: new Date(Date.now() + 86400000),
    location: "Salón",
    userId: adminUser.id,
  });
  event.lot = await Lot.create({ eventId: event.id, name: "General", price: 1000, quantity: 100, ticketsAvailable: 100 });
  accountA = await PaymentAccount.create({ name: "Cuenta A", accessToken: encrypt(TOKEN_A), tokenHint: TOKEN_A.slice(-4) });
  accountB = await PaymentAccount.create({ name: "Cuenta B", accessToken: encrypt(TOKEN_B), tokenHint: TOKEN_B.slice(-4) });

  globalThis.fetch = async (url, options = {}) => {
    if (!String(url).startsWith("https://api.mercadopago.com")) return realFetch(url, options);
    const { status = 200, body } = await mpHandler(String(url), options);
    return new Response(JSON.stringify(body), { status });
  };

  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  globalThis.fetch = realFetch;
  server.close();
  await sequelize.close();
});

test("ataque: pago aprobado de la cuenta B no confirma una compra de la cuenta A", async () => {
  const purchase = await makePurchase({ paymentAccountId: accountA.id });
  payment(purchase.paymentGatewayId, "approved", 1000);

  const res = await webhook(accountB.id);

  assert.equal(res.status, 404);
  assert.match(res.body.message, /Compra no encontrada/);
  assert.deepEqual(await state(purchase), { status: "pending", tickets: 0 });
});

test("ataque de anulación: un pago devuelto de la cuenta B no toca una compra completada de A", async () => {
  const purchase = await makePurchase({ paymentAccountId: accountA.id, status: "completed", withTickets: true });
  payment(purchase.paymentGatewayId, "refunded", 1000);

  const res = await webhook(accountB.id);

  assert.equal(res.status, 404);
  assert.deepEqual(await state(purchase), { status: "completed", tickets: 1 });
});

test("ataque: un pago rechazado/cancelado de B no marca como fallida una compra pendiente de A", async () => {
  const purchase = await makePurchase({ paymentAccountId: accountA.id });
  payment(purchase.paymentGatewayId, "cancelled");

  assert.equal((await webhook(accountB.id)).status, 404);
  assert.deepEqual(await state(purchase), { status: "pending", tickets: 0 });
  assert.equal((await Lot.findByPk(event.lot.id)).ticketsAvailable, 100); // no se libera cupo
});

test("legítimo: el aviso con la cuenta de la compra emite las entradas", async () => {
  const purchase = await makePurchase({ paymentAccountId: accountA.id });
  payment(purchase.paymentGatewayId, "approved", 1000);

  const res = await webhook(accountA.id);

  assert.equal(res.status, 200);
  assert.deepEqual(await state(purchase), { status: "completed", tickets: 1 });
});

test("legítimo: compra vieja sin cuenta y aviso sin acc emite las entradas", async () => {
  const purchase = await makePurchase({ paymentAccountId: null });
  payment(purchase.paymentGatewayId, "approved", 1000);

  const res = await webhook();

  assert.equal(res.status, 200);
  assert.deepEqual(await state(purchase), { status: "completed", tickets: 1 });
});

test("compra con cuenta y aviso SIN acc: 404 y sin cambios", async () => {
  const purchase = await makePurchase({ paymentAccountId: accountA.id });
  payment(purchase.paymentGatewayId, "approved", 1000);

  const res = await webhook();

  assert.equal(res.status, 404);
  assert.deepEqual(await state(purchase), { status: "pending", tickets: 0 });
});

test("compra sin cuenta y aviso CON acc: 404 y sin cambios", async () => {
  const purchase = await makePurchase({ paymentAccountId: null });
  payment(purchase.paymentGatewayId, "approved", 1000);

  const res = await webhook(accountB.id);

  assert.equal(res.status, 404);
  assert.deepEqual(await state(purchase), { status: "pending", tickets: 0 });
});

test("acc inexistente (UUID válido sin cuenta): no emite entradas", async () => {
  const purchase = await makePurchase({ paymentAccountId: null });
  payment(purchase.paymentGatewayId, "approved", 1000);

  const res = await webhook("00000000-0000-4000-8000-000000000000");

  assert.ok(res.status >= 400, `se esperaba un error y llegó ${res.status}`);
  assert.deepEqual(await state(purchase), { status: "pending", tickets: 0 });
});

test("el log WEBHOOK_ACC_MISMATCH no incluye emails ni tokens de la compra", async () => {
  const purchase = await makePurchase({ paymentAccountId: accountA.id });
  payment(purchase.paymentGatewayId, "approved", 1000);

  const { result, logs } = await captureLogs(() => webhook(accountB.id));

  assert.equal(result.status, 404);
  assert.match(logs, /WEBHOOK_ACC_MISMATCH/);
  const row = await Purchase.findByPk(purchase.id);
  for (const secret of [BUYER_EMAIL, "victima.secreta", row.accessToken, TOKEN_A, TOKEN_B, "ENV-token-del-entorno"]) {
    assert.ok(secret, "el secreto a buscar no puede estar vacío");
    assert.ok(!logs.includes(secret), `el log contiene datos sensibles: ${secret}`);
  }
});
