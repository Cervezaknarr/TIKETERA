// Cuentas de Mercado Pago del panel, pausa de ventas y validación del monto, con SQLite en memoria
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
const jwt = require("jsonwebtoken");

const app = require("../server");
const { sequelize } = require("../config/database");
const User = require("../models/User");
const Event = require("../models/Event");
const Lot = require("../models/Lot");
const Purchase = require("../models/Purchase");
const Ticket = require("../models/Ticket");
const PaymentAccount = require("../models/PaymentAccount");
const { encrypt, decrypt } = require("../utils/secrets");

const TOKEN_A = "APP_USR-cuenta-a-1111111111";
const TOKEN_B = "APP_USR-cuenta-b-2222222222";

let server;
let baseUrl;
let adminToken;
let staffToken;
let event;

// API de Mercado Pago simulada: el resto de las llamadas (al propio servidor) pasa de largo
const realFetch = globalThis.fetch;
let mpCalls = [];
let mpHandler;
const defaultHandler = (url) => {
  if (url.endsWith("/users/me")) return { body: { id: 1 } };
  if (url.endsWith("/checkout/preferences")) return { body: { init_point: "https://mp.test/pagar" } };
  return { status: 404, body: {} };
};

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const admin = (method, path, body) => call(method, path, { token: adminToken, body });

const addAccount = async (name, accessToken) =>
  (await admin("POST", "/api/payment-accounts", { name, accessToken })).body.account;
const setPaused = (paused) => admin("PUT", "/api/payment-accounts/sales-paused", { paused });
const activate = async (account) => {
  await setPaused(true);
  const res = await admin("POST", `/api/payment-accounts/${account.id}/activate`);
  await setPaused(false);
  return res;
};

const checkout = (quantity = 1) =>
  call("POST", "/api/purchases/checkout", {
    body: {
      eventId: event.id,
      lotId: event.lot.id,
      buyerName: "Comprador",
      buyerEmail: "comprador@test.com",
      quantity,
    },
  });

// Aviso de pago de Mercado Pago; `acc` es la cuenta que viaja en la URL de aviso
const webhook = (acc) =>
  call("POST", `/api/purchases/webhook?type=payment&data.id=123456${acc ? `&acc=${acc}` : ""}`, { body: {} });

// Mercado Pago responde que el pago 123456 de esta compra está aprobado por `amount`
const approvedPayment = (purchaseId, amount, seenTokens = []) => {
  mpHandler = (url, options) => {
    if (url.endsWith("/v1/payments/123456")) {
      seenTokens.push(options.headers.Authorization);
      return {
        body: { status: "approved", external_reference: purchaseId, transaction_amount: amount, currency_id: "ARS" },
      };
    }
    return defaultHandler(url);
  };
};

before(async () => {
  await sequelize.sync({ force: true });
  const adminUser = await User.create({ name: "Admin", email: "admin@test.com", password: "secret123", role: "admin" });
  const staffUser = await User.create({ name: "Puerta", email: "puerta@test.com", password: "secret123", role: "staff" });
  adminToken = jwt.sign({ id: adminUser.id }, process.env.JWT_SECRET);
  staffToken = jwt.sign({ id: staffUser.id }, process.env.JWT_SECRET);

  event = await Event.create({
    title: "Evento",
    description: "Prueba",
    date: new Date(Date.now() + 86400000),
    location: "Salón",
    userId: adminUser.id,
  });
  event.lot = await Lot.create({ eventId: event.id, name: "General", price: 1000, quantity: 100, ticketsAvailable: 100 });

  globalThis.fetch = async (url, options = {}) => {
    if (!String(url).startsWith("https://api.mercadopago.com")) return realFetch(url, options);
    mpCalls.push({ url: String(url), options });
    const { status = 200, body } = await mpHandler(String(url), options);
    return new Response(JSON.stringify(body), { status });
  };
  mpHandler = defaultHandler;

  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  globalThis.fetch = realFetch;
  server.close();
  await sequelize.close();
});

test("los tokens se cifran y solo se leen con la clave", () => {
  const encrypted = encrypt(TOKEN_A);
  assert.ok(!encrypted.includes(TOKEN_A));
  assert.equal(decrypt(encrypted), TOKEN_A);
  assert.notEqual(encrypt(TOKEN_A), encrypted); // cada cifrado usa su propio IV

  const previous = process.env.PAYMENT_ACCOUNTS_KEY;
  process.env.PAYMENT_ACCOUNTS_KEY = "otra-clave";
  try {
    assert.throws(() => decrypt(encrypted));
  } finally {
    process.env.PAYMENT_ACCOUNTS_KEY = previous;
  }
});

test("las cuentas de pago y la pausa son solo para admin", async () => {
  assert.equal((await call("GET", "/api/payment-accounts")).status, 401);
  assert.equal((await call("GET", "/api/payment-accounts", { token: staffToken })).status, 403);
  assert.equal((await call("PUT", "/api/payment-accounts/sales-paused", { token: staffToken, body: { paused: true } })).status, 403);
});

test("agregar una cuenta verifica el token, lo guarda cifrado y no lo devuelve", async () => {
  mpCalls = [];
  const res = await admin("POST", "/api/payment-accounts", { name: "Cuenta A", accessToken: TOKEN_A });
  assert.equal(res.status, 201);
  assert.equal(res.body.account.tokenHint, TOKEN_A.slice(-4));
  assert.equal(res.body.account.active, false);
  assert.ok(!JSON.stringify(res.body).includes(TOKEN_A));

  assert.equal(mpCalls[0].url, "https://api.mercadopago.com/users/me");
  assert.equal(mpCalls[0].options.headers.Authorization, `Bearer ${TOKEN_A}`);

  const stored = await PaymentAccount.findByPk(res.body.account.id);
  assert.ok(!stored.accessToken.includes(TOKEN_A));
  assert.equal(decrypt(stored.accessToken), TOKEN_A);

  const list = await admin("GET", "/api/payment-accounts");
  assert.ok(!JSON.stringify(list.body).includes(TOKEN_A));
  assert.equal(list.body.keyConfigured, true);
});

test("un token que Mercado Pago no acepta no se guarda", async () => {
  const before = await PaymentAccount.count();
  mpHandler = () => ({ status: 401, body: { message: "invalid_token" } });
  try {
    const res = await admin("POST", "/api/payment-accounts", { name: "Mala", accessToken: "APP_USR-token-incorrecto-99" });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /no aceptó ese access token/);
  } finally {
    mpHandler = defaultHandler;
  }
  for (const body of [{ name: "", accessToken: TOKEN_A }, { name: "X", accessToken: "corto" }, { name: "X", accessToken: "con espacios en el token 1234" }]) {
    assert.equal((await admin("POST", "/api/payment-accounts", body)).status, 400);
  }
  assert.equal(await PaymentAccount.count(), before);
});

test("sin PAYMENT_ACCOUNTS_KEY no se pueden guardar cuentas", async () => {
  const previous = process.env.PAYMENT_ACCOUNTS_KEY;
  delete process.env.PAYMENT_ACCOUNTS_KEY;
  try {
    const res = await admin("POST", "/api/payment-accounts", { name: "Sin clave", accessToken: TOKEN_B });
    assert.equal(res.status, 500);
    assert.match(res.body.message, /PAYMENT_ACCOUNTS_KEY/);
  } finally {
    process.env.PAYMENT_ACCOUNTS_KEY = previous;
  }
});

test("con las ventas pausadas el checkout no acepta compras y se puede reanudar", async () => {
  assert.equal((await call("GET", "/api/purchases/status")).body.salesPaused, false);

  await setPaused(true);
  assert.equal((await call("GET", "/api/purchases/status")).body.salesPaused, true);
  const before = await Purchase.count();
  const blocked = await checkout();
  assert.equal(blocked.status, 503);
  assert.match(blocked.body.message, /pausadas/);
  assert.equal(await Purchase.count(), before);
  assert.equal((await Lot.findByPk(event.lot.id)).ticketsAvailable, 100); // no reservó cupo

  await setPaused(false);
  assert.equal((await checkout()).status, 201);
  assert.equal((await admin("PUT", "/api/payment-accounts/sales-paused", { paused: "si" })).status, 400);
});

test("cambiar de cuenta exige pausar las ventas y deja una sola activa", async () => {
  const a = (await PaymentAccount.findOne({ where: { name: "Cuenta A" } })).toJSON();
  const b = await addAccount("Cuenta B", TOKEN_B);

  const unpaused = await admin("POST", `/api/payment-accounts/${a.id}/activate`);
  assert.equal(unpaused.status, 409);
  assert.match(unpaused.body.message, /Pausá las ventas/);
  assert.equal(await PaymentAccount.count({ where: { active: true } }), 0);

  assert.equal((await activate(a)).status, 200);
  assert.equal((await activate(b)).status, 200);
  const active = await PaymentAccount.findAll({ where: { active: true } });
  assert.deepEqual(active.map((x) => x.name), ["Cuenta B"]);

  assert.equal((await admin("POST", "/api/payment-accounts/00000000-0000-4000-8000-000000000000/activate")).status, 409); // sin pausa
  await setPaused(true);
  assert.equal((await admin("POST", "/api/payment-accounts/00000000-0000-4000-8000-000000000000/activate")).status, 404);
  await setPaused(false);
});

test("un pago de la cuenta anterior se confirma con el token de esa cuenta", async () => {
  const a = await PaymentAccount.findOne({ where: { name: "Cuenta A" } });
  const b = await PaymentAccount.findOne({ where: { name: "Cuenta B" } });
  await activate(a);

  // La compra se crea con la cuenta A y el aviso lleva su id
  mpCalls = [];
  const created = await checkout(2);
  assert.equal(created.status, 201);
  const preference = JSON.parse(mpCalls.find((c) => c.url.endsWith("/checkout/preferences")).options.body);
  assert.equal(mpCalls[0].options.headers.Authorization, `Bearer ${TOKEN_A}`);
  assert.equal(preference.notification_url, `https://api.ticketera.test/api/purchases/webhook?acc=${a.id}`);
  const purchase = await Purchase.findOne({ where: { paymentGatewayId: created.body.purchase.id } });
  assert.equal(purchase.paymentAccountId, a.id);

  // Se cambia a la cuenta B antes de que llegue el aviso
  await activate(b);
  const seen = [];
  approvedPayment(purchase.id, 2000, seen);
  const res = await webhook(a.id);

  assert.equal(res.status, 200);
  assert.deepEqual(seen, [`Bearer ${TOKEN_A}`]); // se consultó con A, no con la activa
  assert.equal((await Purchase.findByPk(purchase.id)).status, "completed");
  assert.equal(await Ticket.count({ where: { purchaseId: purchase.id } }), 2);

  // Las compras nuevas salen por la cuenta activa
  mpHandler = defaultHandler;
  const next = await checkout();
  const nextPurchase = await Purchase.findOne({ where: { paymentGatewayId: next.body.purchase.id } });
  assert.equal(nextPurchase.paymentAccountId, b.id);
});

test("un aviso sin cuenta se confirma con el token del entorno, no con la cuenta activa", async () => {
  const legacy = await Purchase.create({
    eventId: event.id,
    lotId: event.lot.id,
    lotName: "General",
    unitPrice: 1000,
    buyerEmail: "viejo@test.com",
    buyerName: "Viejo",
    quantity: 1,
    totalPrice: 1000,
    paymentGatewayId: "compra-vieja",
  });
  const seen = [];
  approvedPayment("compra-vieja", 1000, seen); // el external_reference es el paymentGatewayId
  assert.equal((await webhook()).status, 200);
  assert.deepEqual(seen, ["Bearer ENV-token-del-entorno-0000"]);
  const confirmed = await Purchase.findByPk(legacy.id);
  assert.equal(confirmed.paymentAccountId, null);
  assert.equal(confirmed.status, "completed");

  // El id de cuenta tiene que ser un UUID
  assert.equal((await webhook("../../x")).status, 400);
});

test("un pago aprobado por otro monto no emite entradas", async () => {
  const created = await checkout(2);
  const purchase = await Purchase.findOne({ where: { paymentGatewayId: created.body.purchase.id } });
  approvedPayment(purchase.id, 1000); // la compra era de 2000

  const originalError = console.error;
  const logged = [];
  console.error = (message) => logged.push(String(message));
  let res;
  try {
    res = await webhook();
  } finally {
    console.error = originalError;
  }

  assert.equal(res.status, 200);
  assert.match(res.body.message, /requiere revisión/);
  assert.match(logged.join("\n"), /PAGO CON MONTO DISTINTO/);
  assert.equal((await Purchase.findByPk(purchase.id)).status, "pending");
  assert.equal(await Ticket.count({ where: { purchaseId: purchase.id } }), 0);

  // El mismo aviso con el monto correcto sí confirma la compra
  approvedPayment(purchase.id, 2000);
  assert.equal((await webhook()).status, 200);
  assert.equal((await Purchase.findByPk(purchase.id)).status, "completed");
});

test("no se borra la cuenta activa ni una que ya cobró compras", async () => {
  const a = await PaymentAccount.findOne({ where: { name: "Cuenta A" } });
  const b = await PaymentAccount.findOne({ where: { name: "Cuenta B" } });

  assert.equal((await admin("DELETE", `/api/payment-accounts/${b.id}`)).status, 409); // activa
  assert.equal((await admin("DELETE", `/api/payment-accounts/${a.id}`)).status, 409); // con compras

  const spare = await addAccount("Cuenta C", "APP_USR-cuenta-c-3333333333");
  assert.equal((await admin("DELETE", `/api/payment-accounts/${spare.id}`)).status, 200);
  assert.equal(await PaymentAccount.count({ where: { name: "Cuenta C" } }), 0);
  assert.equal((await admin("DELETE", `/api/payment-accounts/${spare.id}`)).status, 404);
});
