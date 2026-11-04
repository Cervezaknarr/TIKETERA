// H-02 / T1.13: registro de auditoría. Las acciones instrumentadas dejan una fila con autor, IP y
// resultado, y NUNCA guardan contraseñas, tokens ni emails completos. GET /api/audit es solo admin.
process.env.DATABASE_URL = "sqlite::memory:";
process.env.JWT_SECRET = "test-secret";
process.env.NODE_ENV = "test";
process.env.RESEND_API_KEY = "re_test_key";
process.env.RESEND_FROM = "Ticketera <entradas@test.com>";
process.env.PAYMENT_ACCOUNTS_KEY = "clave-de-prueba-para-cifrar";
process.env.PAYMENT_PROVIDER = "mercadopago";
process.env.MERCADOPAGO_ACCESS_TOKEN = "ENV-token-del-entorno-0000";
process.env.BACKEND_URL = "https://api.ticketera.test";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");

// Mercado Pago y Resend simulados; el resto de las llamadas (al propio servidor) pasa de largo
const realFetch = globalThis.fetch;
let mpPayment = null;
globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  if (u.includes("api.resend.com")) {
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (u.startsWith("https://api.mercadopago.com")) {
    if (u.endsWith("/users/me")) return new Response(JSON.stringify({ id: 1 }), { status: 200 });
    return new Response(JSON.stringify(mpPayment), { status: 200 });
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
const AuditLog = require("../models/AuditLog");
const PaymentAccount = require("../models/PaymentAccount");
const { encrypt } = require("../utils/secrets");
const { audit } = require("../utils/audit");

const ADMIN_PASSWORD = "clave-admin-123";
const NEW_USER_PASSWORD = "Sup3rSecreta-xyz";
const CHANGED_PASSWORD = "OtraClave-Nueva-987";
const STAFF_PASSWORD = "clave-staff-777";
const ORG_PASSWORD = "clave-org-555";
const MP_TOKEN = "APP_USR-token-super-secreto-QzXwKj";
const MP_TOKEN_HINT = MP_TOKEN.slice(-4);
const BUYER_EMAIL = "comprador.privado@test.com";
const LOGIN_EMAIL = "persona.inexistente@dominio-privado.com";
let accA; // cuenta de la compra
let accB; // cuenta distinta, existente, que llega en la URL del aviso

let server;
let baseUrl;
let admin;
let organizer;
let staff;
let adminToken;
let orgToken;
let staffToken;
let event;
let lot;
let seq = 0;

const sign = (user) => jwt.sign({ id: user.id, v: user.tokenVersion }, process.env.JWT_SECRET);
const call = async (method, path, { token, body, headers } = {}) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const asAdmin = (method, path, body) => call(method, path, { token: adminToken, body });
const asOrg = (method, path, body) => call(method, path, { token: orgToken, body });

const rows = (where) => AuditLog.findAll({ where, order: [["createdAt", "ASC"]] });
const one = async (where) => {
  const found = await rows(where);
  assert.equal(found.length, 1, `se esperaba 1 fila para ${JSON.stringify(where)} y hay ${found.length}`);
  return found[0];
};
const allRowsText = async () => JSON.stringify((await AuditLog.findAll()).map((r) => r.toJSON()));

// Captura console.log / error mientras corre `fn`
const captureLogs = async (fn) => {
  const original = { error: console.error, warn: console.warn, log: console.log };
  const out = [];
  const err = [];
  console.log = (...a) => out.push(a.map(String).join(" "));
  console.warn = (...a) => err.push(a.map(String).join(" "));
  console.error = (...a) => err.push(a.map(String).join(" "));
  try {
    return { result: await fn(), stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    Object.assign(console, original);
  }
};

const newPurchase = async ({ status = "completed", withTickets = true, paymentAccountId = null } = {}) => {
  seq += 1;
  const purchase = await Purchase.create({
    eventId: event.id,
    lotId: lot.id,
    lotName: "General",
    unitPrice: 1000,
    buyerEmail: BUYER_EMAIL,
    buyerName: "Comprador Privado",
    quantity: 1,
    totalPrice: 1000,
    status,
    paymentGatewayId: `compra-audit-${seq}`,
    paymentAccountId,
  });
  if (withTickets) {
    await Ticket.create({ eventId: event.id, purchaseId: purchase.id, lotId: lot.id, lotName: "General", code: `AU${String(seq).padStart(5, "0")}` });
  }
  return purchase;
};
const webhook = (acc) =>
  call("POST", `/api/purchases/webhook?type=payment&data.id=987654${acc ? `&acc=${acc}` : ""}`, { body: {} });
const pay = (purchase, status, amount = 1000) => {
  mpPayment = { status, external_reference: purchase.paymentGatewayId, transaction_amount: amount, currency_id: "ARS" };
};

before(async () => {
  await sequelize.sync({ force: true });
  admin = await User.create({ name: "Admin", email: "admin@test.com", password: ADMIN_PASSWORD, role: "admin" });
  organizer = await User.create({ name: "Org", email: "org@test.com", password: ORG_PASSWORD, role: "organizer" });
  staff = await User.create({ name: "Staff", email: "staff@test.com", password: STAFF_PASSWORD, role: "staff" });
  adminToken = sign(admin);
  orgToken = sign(organizer);
  staffToken = sign(staff);
  event = await Event.create({
    title: "Evento",
    description: "Prueba",
    date: new Date(Date.now() + 86400000),
    location: "Salón",
    userId: admin.id,
    organizerId: organizer.id,
  });
  accA = await PaymentAccount.create({ name: "A", accessToken: encrypt("APP_USR-cuenta-a-1111111111"), tokenHint: "1111" });
  accB = await PaymentAccount.create({ name: "B", accessToken: encrypt("APP_USR-cuenta-b-2222222222"), tokenHint: "2222" });
  lot = await Lot.create({ eventId: event.id, name: "General", price: 1000, quantity: 100, ticketsAvailable: 100 });
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  globalThis.fetch = realFetch;
  server.close();
  await sequelize.close();
});

// (1) Login
test("login fallido: fila con result/ip/userAgent y email ENMASCARADO (ni en la fila ni en stdout)", async () => {
  const { result, stdout } = await captureLogs(() =>
    call("POST", "/api/auth/login", { body: { email: LOGIN_EMAIL, password: "mala-clave-1" }, headers: { "User-Agent": "audit-test/1.0" } })
  );
  assert.equal(result.status, 401);
  const row = await one({ action: "LOGIN_FAIL", result: "failure", actorId: null });
  assert.equal(row.userAgent, "audit-test/1.0");
  assert.ok(row.ip, "debe guardar la IP");
  assert.equal(row.details.reason, "bad_credentials");
  assert.equal(row.details.email, "p***@dominio-privado.com");
  assert.ok(!JSON.stringify(row.toJSON()).includes(LOGIN_EMAIL));
  assert.ok(!JSON.stringify(row.toJSON()).includes("persona.inexistente"));
  assert.match(stdout, /"audit":true/);
  assert.match(stdout, /LOGIN_FAIL/);
  assert.ok(!stdout.includes(LOGIN_EMAIL) && !stdout.includes("persona.inexistente"), "stdout no debe traer el email completo");
});

test("login fallido de un usuario existente guarda su id como autor, sin email completo", async () => {
  const res = await call("POST", "/api/auth/login", { body: { email: "staff@test.com", password: "incorrecta" } });
  assert.equal(res.status, 401);
  const row = await one({ action: "LOGIN_FAIL", actorId: staff.id });
  assert.equal(row.result, "failure");
  assert.equal(row.actorRole, "staff");
  assert.equal(row.details.email, "s***@test.com");
  assert.ok(!JSON.stringify(row.toJSON()).includes("staff@test.com"));
});

test("login correcto: fila LOGIN_OK con autor, ip y userAgent, sin contraseña ni token", async () => {
  const { result, stdout } = await captureLogs(() =>
    call("POST", "/api/auth/login", { body: { email: "admin@test.com", password: ADMIN_PASSWORD }, headers: { "User-Agent": "audit-test/2.0" } })
  );
  assert.equal(result.status, 200);
  const row = await one({ action: "LOGIN_OK" });
  assert.equal(row.result, "success");
  assert.equal(row.actorId, admin.id);
  assert.equal(row.actorRole, "admin");
  assert.equal(row.userAgent, "audit-test/2.0");
  assert.ok(row.ip);
  const text = JSON.stringify(row.toJSON()) + stdout;
  assert.ok(!text.includes(ADMIN_PASSWORD));
  assert.ok(!text.includes(result.body.token), "el JWT no debe quedar en la auditoría");
});

test("login sin campos (400) no genera fila de auditoría", async () => {
  const before = await AuditLog.count();
  const res = await call("POST", "/api/auth/login", { body: { email: "admin@test.com" } });
  assert.equal(res.status, 400);
  assert.equal(await AuditLog.count(), before);
});

test("login de una cuenta sin rol (clave correcta): LOGIN_FAIL denied con email enmascarado", async () => {
  const plain = await User.create({ name: "Sin rol", email: "sinrol@test.com", password: "clave-sinrol-1", role: "user" });
  const res = await call("POST", "/api/auth/login", { body: { email: "sinrol@test.com", password: "clave-sinrol-1" } });
  assert.equal(res.status, 403);
  const row = await one({ action: "LOGIN_FAIL", actorId: plain.id });
  assert.equal(row.result, "denied");
  assert.equal(row.details.reason, "no_role");
  assert.equal(row.details.email, "s***@test.com");
  assert.ok(!JSON.stringify(row.toJSON()).includes("sinrol@test.com"));
});

// (2) Usuarios
let createdUserId;
test("USER_CREATE / USER_UPDATE / USER_DELETE: sin contraseña ni hash en ninguna fila", async () => {
  const created = await asAdmin("POST", "/api/users", {
    name: "Nuevo Staff", email: "nuevo.staff@test.com", password: NEW_USER_PASSWORD, role: "staff", eventIds: [event.id],
  });
  assert.equal(created.status, 201);
  createdUserId = created.body.user.id;
  const createRow = await one({ action: "USER_CREATE" });
  assert.equal(createRow.actorId, admin.id);
  assert.equal(createRow.actorRole, "admin");
  assert.equal(createRow.entityId, createdUserId);
  assert.ok(createRow.ip);

  const updated = await asAdmin("PUT", `/api/users/${createdUserId}`, { name: "Staff Renombrado", password: CHANGED_PASSWORD });
  assert.equal(updated.status, 200);
  const updateRow = await one({ action: "USER_UPDATE" });
  assert.equal(updateRow.actorId, admin.id);
  assert.equal(updateRow.details.passwordChanged, true);
  assert.deepEqual(updateRow.details.name, { from: "Nuevo Staff", to: "Staff Renombrado" });

  const hash = (await User.findByPk(createdUserId)).password;
  assert.ok(hash && hash !== CHANGED_PASSWORD);
  const text = await allRowsText();
  for (const secret of [NEW_USER_PASSWORD, CHANGED_PASSWORD, hash, "$2a$", "$2b$", "nuevo.staff@test.com"]) {
    assert.ok(!text.includes(secret), `la auditoría contiene ${secret}`);
  }

  const deleted = await asAdmin("DELETE", `/api/users/${createdUserId}`);
  assert.equal(deleted.status, 200);
  const deleteRow = await one({ action: "USER_DELETE" });
  assert.equal(deleteRow.entityId, createdUserId);
  assert.equal(deleteRow.actorId, admin.id);
  assert.ok(!(await allRowsText()).includes("nuevo.staff@test.com"));
});

test("USER_UPDATE sin cambiar la clave no marca passwordChanged", async () => {
  const u = await asAdmin("POST", "/api/users", { name: "Otro", email: "otro@test.com", password: "clave-otro-123", role: "staff", eventIds: [event.id] });
  const res = await asAdmin("PUT", `/api/users/${u.body.user.id}`, { name: "Otro Nombre" });
  assert.equal(res.status, 200);
  const rowsU = await rows({ action: "USER_UPDATE", entityId: u.body.user.id });
  assert.equal(rowsU.length, 1);
  assert.equal(rowsU[0].details.passwordChanged, undefined);
});

test("un alta de usuario rechazada (400) no deja fila USER_CREATE", async () => {
  const before = await AuditLog.count({ where: { action: "USER_CREATE" } });
  const res = await asAdmin("POST", "/api/users", { name: "X", email: "x@test.com", password: "corta", role: "staff" });
  assert.equal(res.status, 400);
  assert.equal(await AuditLog.count({ where: { action: "USER_CREATE" } }), before);
});

// STAFF_* del organizador
test("STAFF_CREATE / STAFF_UPDATE / STAFF_DELETE del organizador: autor, evento y sin contraseña", async () => {
  const pw = "clave-staff-org-111";
  const pw2 = "clave-staff-org-222";
  const created = await asOrg("POST", `/api/organizer/events/${event.id}/staff`, { name: "Staff Org", email: "staff.org@test.com", password: pw });
  assert.equal(created.status, 201);
  const id = created.body.user.id;
  const c = await one({ action: "STAFF_CREATE" });
  assert.equal(c.actorId, organizer.id);
  assert.equal(c.actorRole, "organizer");
  assert.equal(c.eventId, event.id);
  assert.equal(c.entityId, id);

  const upd = await asOrg("PUT", `/api/organizer/events/${event.id}/staff/${id}`, { password: pw2 });
  assert.equal(upd.status, 200);
  const u = await one({ action: "STAFF_UPDATE" });
  assert.equal(u.actorId, organizer.id);
  assert.equal(u.details.passwordChanged, true);

  const del = await asOrg("DELETE", `/api/organizer/events/${event.id}/staff/${id}`);
  assert.equal(del.status, 200);
  const d = await one({ action: "STAFF_DELETE" });
  assert.equal(d.actorId, organizer.id);
  assert.equal(d.eventId, event.id);
  assert.equal(d.details.userDeleted, true);

  const text = await allRowsText();
  for (const secret of [pw, pw2, "staff.org@test.com"]) assert.ok(!text.includes(secret));
});

// (3) Cuentas de pago
test("PAYMENT_ACCOUNT_CREATE/ACTIVATE/DELETE (admin): ninguna fila contiene el token ni su hint", async () => {
  const created = await asAdmin("POST", "/api/payment-accounts", { name: "Cuenta Auditada", accessToken: MP_TOKEN });
  assert.equal(created.status, 201);
  const id = created.body.account.id;
  const c = await one({ action: "PAYMENT_ACCOUNT_CREATE", entityId: id });
  assert.equal(c.actorId, admin.id);
  assert.equal(c.details.name, "Cuenta Auditada");

  const other = await asAdmin("POST", "/api/payment-accounts", { name: "Cuenta Dos", accessToken: "APP_USR-otro-token-9999999999" });
  assert.equal((await asAdmin("PUT", "/api/payment-accounts/sales-paused", { paused: true })).status, 200);
  const act = await asAdmin("POST", `/api/payment-accounts/${id}/activate`);
  assert.equal(act.status, 200);
  const a = await one({ action: "PAYMENT_ACCOUNT_ACTIVATE", entityId: id });
  assert.equal(a.actorId, admin.id);
  assert.equal(a.details.activeAccountId.to, id);
  assert.equal((await asAdmin("PUT", "/api/payment-accounts/sales-paused", { paused: false })).status, 200);

  const del = await asAdmin("DELETE", `/api/payment-accounts/${other.body.account.id}`);
  assert.equal(del.status, 200);
  const d = await one({ action: "PAYMENT_ACCOUNT_DELETE", entityId: other.body.account.id });
  assert.equal(d.actorId, admin.id);

  const text = await allRowsText();
  assert.ok(!text.includes(MP_TOKEN), "la auditoría contiene el token");
  assert.ok(!text.includes("APP_USR"));
  assert.ok(!text.includes(MP_TOKEN_HINT), "la auditoría contiene el hint del token");
  assert.ok(!/tokenHint|accessToken/.test(text));
});

test("cuentas de pago del organizador: acciones con eventId y sin token", async () => {
  const token = "APP_USR-token-organizador-ABCDEFG123";
  const created = await asOrg("POST", `/api/organizer/events/${event.id}/payments/accounts`, { name: "Propia", accessToken: token });
  assert.equal(created.status, 201);
  const id = created.body.account.id;
  const c = await one({ action: "PAYMENT_ACCOUNT_CREATE", entityId: id });
  assert.equal(c.actorId, organizer.id);
  assert.equal(c.eventId, event.id);

  assert.equal((await asOrg("PUT", `/api/organizer/events/${event.id}/sales-paused`, { paused: true })).status, 200);
  assert.equal((await asOrg("POST", `/api/organizer/events/${event.id}/payments/accounts/${id}/activate`)).status, 200);
  const a = await one({ action: "PAYMENT_ACCOUNT_ACTIVATE", entityId: id });
  assert.equal(a.eventId, event.id);
  assert.equal(a.actorId, organizer.id);

  const second = await asOrg("POST", `/api/organizer/events/${event.id}/payments/accounts`, { name: "Segunda", accessToken: "APP_USR-segundo-token-ZZZZZZZZ1234" });
  assert.equal((await asOrg("DELETE", `/api/organizer/events/${event.id}/payments/accounts/${second.body.account.id}`)).status, 200);
  const d = await one({ action: "PAYMENT_ACCOUNT_DELETE", entityId: second.body.account.id });
  assert.equal(d.actorId, organizer.id);

  assert.equal((await asOrg("PUT", `/api/organizer/events/${event.id}/sales-paused`, { paused: false })).status, 200);
  const text = await allRowsText();
  assert.ok(!text.includes(token));
  assert.ok(!text.includes("APP_USR-segundo"));
});

test("alta de cuenta con token inválido (400) no deja fila", async () => {
  const before = await AuditLog.count({ where: { action: "PAYMENT_ACCOUNT_CREATE" } });
  const res = await asAdmin("POST", "/api/payment-accounts", { name: "Mala", accessToken: "corto" });
  assert.equal(res.status, 400);
  assert.equal(await AuditLog.count({ where: { action: "PAYMENT_ACCOUNT_CREATE" } }), before);
});

// (4) Pausa de ventas
test("SALES_PAUSE / SALES_RESUME (general y por evento) con actor", async () => {
  const before = { pause: await AuditLog.count({ where: { action: "SALES_PAUSE" } }), resume: await AuditLog.count({ where: { action: "SALES_RESUME" } }) };
  assert.equal((await asAdmin("PUT", "/api/payment-accounts/sales-paused", { paused: true })).status, 200);
  assert.equal((await asAdmin("PUT", "/api/payment-accounts/sales-paused", { paused: false })).status, 200);
  assert.equal((await asOrg("PUT", `/api/organizer/events/${event.id}/sales-paused`, { paused: true })).status, 200);
  assert.equal((await asOrg("PUT", `/api/organizer/events/${event.id}/sales-paused`, { paused: false })).status, 200);

  const pauses = await rows({ action: "SALES_PAUSE" });
  const resumes = await rows({ action: "SALES_RESUME" });
  assert.equal(pauses.length, before.pause + 2);
  assert.equal(resumes.length, before.resume + 2);
  const general = pauses.at(-2);
  assert.equal(general.actorId, admin.id);
  assert.equal(general.entityType, "Setting");
  assert.deepEqual(general.details.salesPaused, { from: false, to: true });
  const perEvent = pauses.at(-1);
  assert.equal(perEvent.actorId, organizer.id);
  assert.equal(perEvent.actorRole, "organizer");
  assert.equal(perEvent.eventId, event.id);
  assert.equal(resumes.at(-1).actorId, organizer.id);
  assert.deepEqual(resumes.at(-1).details.salesPaused, { from: true, to: false });
});

test("pausa con body inválido (400) no deja fila", async () => {
  const before = await AuditLog.count({ where: { action: ["SALES_PAUSE", "SALES_RESUME"] } });
  const res = await asAdmin("PUT", "/api/payment-accounts/sales-paused", { paused: "si" });
  assert.equal(res.status, 400);
  assert.equal(await AuditLog.count({ where: { action: ["SALES_PAUSE", "SALES_RESUME"] } }), before);
});

// (5) Anulación manual
test("PURCHASE_VOID manual: actorId de quien anuló, sin buyerEmail ni accessToken", async () => {
  const purchase = await newPurchase();
  const res = await asOrg("POST", `/api/purchases/event/${event.id}/${purchase.id}/void`);
  assert.equal(res.status, 200);
  const row = await one({ action: "PURCHASE_VOID", entityId: purchase.id });
  assert.equal(row.actorId, organizer.id);
  assert.equal(row.actorRole, "organizer");
  assert.equal(row.eventId, event.id);
  assert.equal(row.result, "success");
  const json = JSON.stringify(row.toJSON());
  assert.ok(!json.includes(BUYER_EMAIL) && !json.includes("buyerEmail"));
  assert.ok(!json.includes(purchase.accessToken) && !json.includes("accessToken"));
  assert.ok(!json.includes("Comprador Privado"));

  // anularla de nuevo falla y no agrega otra fila
  const again = await asOrg("POST", `/api/purchases/event/${event.id}/${purchase.id}/void`);
  assert.equal(again.status, 400);
  assert.equal((await rows({ action: "PURCHASE_VOID", entityId: purchase.id })).length, 1);
});

test("anulación manual de un organizador ajeno (403) no deja fila", async () => {
  const other = await User.create({ name: "Otro Org", email: "otroorg@test.com", password: "clave-otro-org-1", role: "organizer" });
  const purchase = await newPurchase();
  const res = await call("POST", `/api/purchases/event/${event.id}/${purchase.id}/void`, { token: sign(other) });
  assert.equal(res.status, 403);
  assert.equal(await AuditLog.count({ where: { action: "PURCHASE_VOID", entityId: purchase.id } }), 0);
});

// (6) Webhook
test("webhook de devolución sobre compra completed: PURCHASE_VOID_AUTO sin actor ni email", async () => {
  const purchase = await newPurchase();
  pay(purchase, "refunded");
  const res = await webhook();
  assert.equal(res.status, 200);
  assert.equal((await Purchase.findByPk(purchase.id)).status, "refunded");
  const row = await one({ action: "PURCHASE_VOID_AUTO", entityId: purchase.id });
  assert.equal(row.actorId, null);
  assert.equal(row.actorRole, null);
  assert.equal(row.eventId, event.id);
  assert.equal(row.details.ticketsVoided, 1);
  const json = JSON.stringify(row.toJSON());
  assert.ok(!json.includes(BUYER_EMAIL) && !json.includes("accessToken") && !json.includes(purchase.accessToken));
});

test("webhook con monto distinto: PAYMENT_AMOUNT_MISMATCH denied, sin actor y sin emitir entradas", async () => {
  const purchase = await newPurchase({ status: "pending", withTickets: false });
  pay(purchase, "approved", 1);
  const res = await captureLogs(() => webhook());
  assert.equal(res.result.status, 200);
  const row = await one({ action: "PAYMENT_AMOUNT_MISMATCH", entityId: purchase.id });
  assert.equal(row.result, "denied");
  assert.equal(row.actorId, null);
  assert.equal(row.eventId, event.id);
  assert.ok(!JSON.stringify(row.toJSON()).includes(BUYER_EMAIL));
  assert.equal(await Ticket.count({ where: { purchaseId: purchase.id } }), 0);
});

test("webhook con acc distinto: WEBHOOK_ACC_MISMATCH denied sin el valor de acc", async () => {
  const purchase = await newPurchase({ status: "pending", withTickets: false, paymentAccountId: accA.id });
  pay(purchase, "approved", 1000);
  const { result, stdout } = await captureLogs(() => webhook(accB.id));
  assert.equal(result.status, 404);
  const row = await one({ action: "WEBHOOK_ACC_MISMATCH", entityId: purchase.id });
  assert.equal(row.result, "denied");
  assert.equal(row.actorId, null);
  const json = JSON.stringify(row.toJSON());
  assert.ok(!json.includes(accB.id));
  assert.ok(!json.includes(BUYER_EMAIL));
  // server.js:78 loguea `${method} ${url}` (incluye ?acc=): es el logger de requests, no la auditoría
  const auditLines = stdout.split("\n").filter((l) => l.startsWith('{"audit":true'));
  assert.equal(auditLines.length, 1);
  assert.ok(!auditLines[0].includes(accB.id), "la línea de auditoría no debe traer el acc recibido");
});

test("webhook sin compra asociada no deja fila de acc mismatch", async () => {
  const before = await AuditLog.count({ where: { action: "WEBHOOK_ACC_MISMATCH" } });
  mpPayment = { status: "approved", external_reference: "no-existe", transaction_amount: 1000, currency_id: "ARS" };
  const res = await webhook(accA.id);
  assert.equal(res.status, 404);
  assert.equal(await AuditLog.count({ where: { action: "WEBHOOK_ACC_MISMATCH" } }), before);
});

test("pago aprobado sin cupo tras vencer la reserva: PAYMENT_NO_STOCK failure sin actor", async () => {
  const soldOut = await Lot.create({ eventId: event.id, name: "Agotado", price: 1000, quantity: 1, ticketsAvailable: 0 });
  seq += 1;
  const purchase = await Purchase.create({
    eventId: event.id, lotId: soldOut.id, lotName: "Agotado", unitPrice: 1000, buyerEmail: BUYER_EMAIL, buyerName: "Comprador",
    quantity: 1, totalPrice: 1000, status: "failed", paymentGatewayId: `compra-audit-${seq}`,
  });
  pay(purchase, "approved", 1000);
  const res = await captureLogs(() => webhook());
  assert.equal(res.result.status, 200);
  const row = await rows({ action: "PAYMENT_NO_STOCK", entityId: purchase.id });
  assert.equal(row.length, 1, "no se auditó PAYMENT_NO_STOCK (¿la compra no cayó en paid_without_stock?)");
  assert.equal(row[0].result, "failure");
  assert.equal(row[0].actorId, null);
  assert.ok(!JSON.stringify(row[0].toJSON()).includes(BUYER_EMAIL));
});

// (7) Reenvío
test("TICKETS_RESEND: éxito y luego cooldown (429) como failure, sin email del comprador", async () => {
  const purchase = await newPurchase();
  const ok = await asOrg("POST", `/api/purchases/event/${event.id}/${purchase.id}/resend`);
  assert.equal(ok.status, 200);
  const cooldown = await asOrg("POST", `/api/purchases/event/${event.id}/${purchase.id}/resend`);
  assert.equal(cooldown.status, 429);

  const found = await rows({ action: "TICKETS_RESEND", entityId: purchase.id });
  assert.equal(found.length, 2);
  assert.equal(found[0].result, "success");
  assert.equal(found[0].actorId, organizer.id);
  assert.equal(found[1].result, "failure");
  assert.equal(found[1].actorId, organizer.id);
  assert.equal(found[1].details.reason, "cooldown");
  assert.equal(found[1].details.status, 429);
  assert.ok(!JSON.stringify(found.map((r) => r.toJSON())).includes(BUYER_EMAIL));
});

test("TICKETS_RESEND con el mail caído (502) deja failure send_error", async () => {
  const purchase = await newPurchase();
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, options) =>
    String(url).includes("api.resend.com") ? new Response(JSON.stringify({ message: "boom" }), { status: 500 }) : saved(url, options);
  try {
    const { result } = await captureLogs(() => asAdmin("POST", `/api/purchases/event/${event.id}/${purchase.id}/resend`));
    assert.equal(result.status, 502);
  } finally {
    globalThis.fetch = saved;
  }
  const row = await one({ action: "TICKETS_RESEND", entityId: purchase.id });
  assert.equal(row.result, "failure");
  assert.equal(row.details.reason, "send_error");
  assert.equal(row.actorId, admin.id);
});

// Eventos, lotes y packs
let lotsEventId;
test("EVENT_CREATE / EVENT_UPDATE (solo campos cambiados, portada: true) / EVENT_DELETE", async () => {
  const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const created = await asAdmin("POST", "/api/events", {
    title: "Fiesta", description: "Prueba", date: new Date(Date.now() + 86400000).toISOString(), location: "Club", status: "draft",
    lots: [{ name: "General", price: 1000, quantity: 10 }],
  });
  assert.equal(created.status, 201);
  const id = created.body.event.id;
  lotsEventId = id;
  const c = await one({ action: "EVENT_CREATE", entityId: id });
  assert.equal(c.actorId, admin.id);
  assert.equal(c.eventId, id);
  assert.equal(c.details.lots, 1);

  const upd = await asAdmin("PUT", `/api/events/${id}`, { title: "Fiesta", imageUrl: image, status: "published", description: "Otra descripción larga" });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  const u = await one({ action: "EVENT_UPDATE", entityId: id });
  assert.equal(u.actorId, admin.id);
  assert.equal(u.details.imageUrl, true);
  assert.equal(u.details.description, true);
  assert.deepEqual(u.details.status, { from: "draft", to: "published" });
  assert.equal(u.details.title, undefined, "title no cambió");
  const json = JSON.stringify(u.toJSON());
  assert.ok(!json.includes("iVBORw0KGgo") && !json.includes("Otra descripción"));

  const del = await asAdmin("DELETE", `/api/events/${id}`);
  assert.equal(del.status, 200);
  const d = await one({ action: "EVENT_DELETE", entityId: id });
  assert.equal(d.actorId, admin.id);
});

test("EVENT_DELETE de un evento con compras lo cancela y lo registra", async () => {
  const withSales = await Event.create({ title: "Con ventas", description: "x", date: new Date(Date.now() + 86400000), location: "Sala", userId: admin.id, status: "published" });
  const l = await Lot.create({ eventId: withSales.id, name: "G", price: 1, quantity: 5, ticketsAvailable: 4 });
  await Purchase.create({ eventId: withSales.id, lotId: l.id, lotName: "G", unitPrice: 1, buyerEmail: BUYER_EMAIL, buyerName: "C", quantity: 1, totalPrice: 1, status: "completed", paymentGatewayId: "venta-evt" });
  const res = await asAdmin("DELETE", `/api/events/${withSales.id}`);
  assert.equal(res.status, 200);
  const row = await one({ action: "EVENT_DELETE", entityId: withSales.id });
  assert.equal(row.details.cancelledInsteadOfDeleted, true);
  assert.deepEqual(row.details.status, { from: "published", to: "cancelled" });
});

test("EVENT_UPDATE sin cambios reales no filtra datos y un evento inexistente (404) no deja fila", async () => {
  const res = await asAdmin("PUT", "/api/events/00000000-0000-4000-8000-000000000001", { title: "x" });
  assert.equal(res.status, 404);
  assert.equal(await AuditLog.count({ where: { entityId: "00000000-0000-4000-8000-000000000001" } }), 0);
});

test("LOT_CREATE / LOT_UPDATE / LOT_DELETE y PACK_CREATE / PACK_UPDATE / PACK_DELETE con actor y evento", async () => {
  const created = await asAdmin("POST", `/api/events/${event.id}/lots`, { name: "VIP", price: 5000, quantity: 10 });
  assert.equal(created.status, 201);
  const lotId = created.body.lot.id;
  const lc = await one({ action: "LOT_CREATE", entityId: lotId });
  assert.equal(lc.actorId, admin.id);
  assert.equal(lc.eventId, event.id);

  const upd = await asAdmin("PUT", `/api/events/${event.id}/lots/${lotId}`, { price: 6000 });
  assert.equal(upd.status, 200);
  const lu = await one({ action: "LOT_UPDATE", entityId: lotId });
  assert.deepEqual(lu.details.price, { from: 5000, to: 6000 });
  assert.equal(lu.details.quantity, undefined);

  const pack = await asAdmin("POST", `/api/events/${event.id}/packs`, { lotId, quantity: 4, discountPercent: 10 });
  assert.equal(pack.status, 201);
  const packId = pack.body.pack.id;
  const pc = await one({ action: "PACK_CREATE", entityId: packId });
  assert.equal(pc.actorId, admin.id);
  assert.equal(pc.eventId, event.id);

  const pu = await asAdmin("PUT", `/api/events/${event.id}/packs/${packId}`, { discountPercent: 15 });
  assert.equal(pu.status, 200);
  const puRow = await one({ action: "PACK_UPDATE", entityId: packId });
  assert.equal(puRow.actorId, admin.id);

  assert.equal((await asAdmin("DELETE", `/api/events/${event.id}/packs/${packId}`)).status, 200);
  assert.equal((await one({ action: "PACK_DELETE", entityId: packId })).actorId, admin.id);

  assert.equal((await asAdmin("DELETE", `/api/events/${event.id}/lots/${lotId}`)).status, 200);
  assert.equal((await one({ action: "LOT_DELETE", entityId: lotId })).eventId, event.id);
});

// (9) GET /api/audit
test("GET /api/audit: 200 admin; 401 sin token; 403 organizador y staff", async () => {
  const ok = await asAdmin("GET", "/api/audit");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.success, true);
  assert.ok(Array.isArray(ok.body.logs) && ok.body.logs.length > 0);
  assert.equal(ok.body.limit, 50);
  assert.equal(ok.body.offset, 0);
  assert.ok(ok.body.total >= ok.body.logs.length);

  assert.equal((await call("GET", "/api/audit")).status, 401);
  assert.equal((await call("GET", "/api/audit", { token: "basura" })).status, 401);
  assert.equal((await asOrg("GET", "/api/audit")).status, 403);
  assert.equal((await call("GET", "/api/audit", { token: staffToken })).status, 403);
  // El 403 no filtra filas
  assert.equal((await asOrg("GET", "/api/audit")).body.logs, undefined);
});

test("GET /api/audit: orden createdAt desc, paginación sin solapar y tope de limit", async () => {
  const total = await AuditLog.count();
  assert.ok(total > 5);
  const page1 = await asAdmin("GET", "/api/audit?limit=3&offset=0");
  const page2 = await asAdmin("GET", "/api/audit?limit=3&offset=3");
  assert.equal(page1.body.logs.length, 3);
  assert.equal(page2.body.logs.length, 3);
  assert.equal(page1.body.total, total);
  const ids1 = page1.body.logs.map((l) => l.id);
  assert.ok(page2.body.logs.every((l) => !ids1.includes(l.id)));
  const times = page1.body.logs.concat(page2.body.logs).map((l) => new Date(l.createdAt).getTime());
  assert.deepEqual([...times].sort((a, b) => b - a), times);

  const past = await asAdmin("GET", `/api/audit?offset=${total + 100}`);
  assert.equal(past.status, 200);
  assert.deepEqual(past.body.logs, []);

  const capped = await asAdmin("GET", "/api/audit?limit=500");
  assert.equal(capped.status, 200);
  assert.equal(capped.body.limit, 200);
  assert.ok(capped.body.logs.length <= 200);
  const low = await asAdmin("GET", "/api/audit?limit=0");
  assert.equal(low.status, 200);
  assert.equal(low.body.limit, 1);
});

test("GET /api/audit: filtros por action, actorId y eventId; combinados y sin resultados", async () => {
  const byAction = await asAdmin("GET", "/api/audit?action=LOGIN_FAIL&limit=200");
  assert.equal(byAction.status, 200);
  assert.ok(byAction.body.logs.length >= 3);
  assert.ok(byAction.body.logs.every((l) => l.action === "LOGIN_FAIL"));

  const byActor = await asAdmin("GET", `/api/audit?actorId=${organizer.id}&limit=200`);
  assert.ok(byActor.body.logs.length > 0);
  assert.ok(byActor.body.logs.every((l) => l.actorId === organizer.id));

  const byEvent = await asAdmin("GET", `/api/audit?eventId=${event.id}&action=SALES_PAUSE&limit=200`);
  assert.ok(byEvent.body.logs.length > 0);
  assert.ok(byEvent.body.logs.every((l) => l.eventId === event.id && l.action === "SALES_PAUSE"));

  const none = await asAdmin("GET", "/api/audit?action=NO_EXISTE");
  assert.equal(none.status, 200);
  assert.equal(none.body.total, 0);
  assert.deepEqual(none.body.logs, []);
});

test("GET /api/audit: filtro por fecha (from/to) y 400 con valores inválidos", async () => {
  const total = await AuditLog.count();
  const today = new Date().toISOString().slice(0, 10);
  const inRange = await asAdmin("GET", `/api/audit?from=${today}&to=${today}&limit=1`);
  assert.equal(inRange.status, 200);
  assert.equal(inRange.body.total, total);
  const future = await asAdmin("GET", "/api/audit?from=2999-01-01");
  assert.equal(future.status, 200);
  assert.equal(future.body.total, 0);
  const past = await asAdmin("GET", "/api/audit?to=2000-01-01");
  assert.equal(past.body.total, 0);

  for (const q of ["from=no-es-fecha", "to=ayer", "from=2024-13-45", "limit=abc", "limit=1.5", "offset=x", "action[]=a&action[]=b", "from=2020-01-01&from=2021-01-01"]) {
    const res = await asAdmin("GET", `/api/audit?${q}`);
    assert.equal(res.status, 400, `?${q} debería dar 400 y dio ${res.status}`);
    assert.equal(res.body.success, false);
  }
});

test("GET /api/audit: un filtro con comillas o SQL no rompe ni inyecta", async () => {
  const res = await asAdmin("GET", `/api/audit?action=${encodeURIComponent("x' OR '1'='1")}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 0);
});

// (10) Append-only vía API
test("append-only: ninguna ruta actualiza ni borra filas (PUT/PATCH/DELETE/POST en /api/audit)", async () => {
  const before = JSON.stringify((await AuditLog.findAll({ order: [["id", "ASC"]] })).map((r) => r.toJSON()));
  const sample = (await AuditLog.findOne()).id;
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    for (const path of ["/api/audit", `/api/audit/${sample}`]) {
      for (const token of [adminToken, orgToken, undefined]) {
        const res = await call(method, path, { token, body: { action: "HACKED" } });
        assert.ok([401, 403, 404].includes(res.status), `${method} ${path} devolvió ${res.status}`);
      }
    }
  }
  const after = JSON.stringify((await AuditLog.findAll({ order: [["id", "ASC"]] })).map((r) => r.toJSON()));
  assert.equal(after, before);
});

test("append-only: el controlador y las rutas de auditoría solo exponen lectura", () => {
  const router = require("../routes/auditRoutes");
  const methods = router.stack.flatMap((layer) => (layer.route ? Object.keys(layer.route.methods) : []));
  assert.deepEqual(methods, ["get"]);
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.join(__dirname, "..");
  for (const sub of ["controllers", "routes", "utils", "middleware"]) {
    for (const file of fs.readdirSync(path.join(dir, sub))) {
      if (!file.endsWith(".js")) continue;
      const src = fs.readFileSync(path.join(dir, sub, file), "utf8");
      assert.ok(!/AuditLog\.(update|destroy|upsert|bulkCreate|truncate)\b/.test(src), `${sub}/${file} modifica AuditLog`);
    }
  }
});

// (11) Si la escritura falla, la acción de negocio sigue funcionando
test("si AuditLog.create falla: la acción responde bien y sale AUDIT_WRITE_FAILED sin datos personales", async () => {
  const original = AuditLog.create;
  AuditLog.create = async () => {
    throw new Error(`disco lleno ${BUYER_EMAIL} ${MP_TOKEN} ${NEW_USER_PASSWORD}`);
  };
  const before = await AuditLog.count();
  let captured;
  try {
    captured = await captureLogs(() => asAdmin("PUT", "/api/payment-accounts/sales-paused", { paused: true }));
  } finally {
    AuditLog.create = original;
  }
  assert.equal(captured.result.status, 200);
  assert.equal(captured.result.body.salesPaused, true);
  assert.match(captured.stderr, /AUDIT_WRITE_FAILED action=SALES_PAUSE/);
  for (const secret of [BUYER_EMAIL, MP_TOKEN, NEW_USER_PASSWORD, "disco lleno"]) {
    assert.ok(!captured.stderr.includes(secret) && !captured.stdout.includes(secret), `se filtró ${secret}`);
  }
  assert.ok(!captured.stdout.includes('"audit":true'), "sin fila no debe emitirse la línea de auditoría");
  assert.equal(await AuditLog.count(), before);
  // la acción de negocio sí ocurrió
  assert.equal((await asAdmin("PUT", "/api/payment-accounts/sales-paused", { paused: false })).status, 200);
});

test("audit() nunca lanza, aunque falte req o la acción sea inválida", async () => {
  const original = AuditLog.create;
  AuditLog.create = async () => {
    throw new Error("falla");
  };
  try {
    const { stderr } = await captureLogs(async () => {
      await audit(undefined, { action: "X" });
      await audit(null);
      await audit({}, undefined);
    });
    assert.match(stderr, /AUDIT_WRITE_FAILED/);
  } finally {
    AuditLog.create = original;
  }
});

test("audit() sin req válido y con result inválido: normaliza a success y details vacío a null", async () => {
  await audit({ headers: {} }, { action: "TEST_NORMALIZE", result: "raro", details: {} });
  const row = await one({ action: "TEST_NORMALIZE" });
  assert.equal(row.result, "success");
  assert.equal(row.details, null);
  assert.equal(row.actorId, null);
});

test("la línea de stdout de una acción es JSON con audit:true y coincide con la fila", async () => {
  const { stdout } = await captureLogs(() => asAdmin("PUT", "/api/payment-accounts/sales-paused", { paused: true }));
  await asAdmin("PUT", "/api/payment-accounts/sales-paused", { paused: false });
  const line = stdout.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((j) => j && j.audit);
  assert.ok(line, "debe haber una línea JSON de auditoría");
  assert.equal(line.action, "SALES_PAUSE");
  assert.equal(line.actorId, admin.id);
  const row = await AuditLog.findByPk(line.id);
  assert.ok(row);
  assert.equal(row.action, line.action);
});

// (12) Revisión final de toda la tabla
test("ninguna fila tiene claves password/token/accessToken ni valores de secretos en details", async () => {
  const all = await AuditLog.findAll();
  assert.ok(all.length > 30, `solo hay ${all.length} filas: ¿corrieron los flujos anteriores?`);
  const FORBIDDEN_KEYS = /^(password|passwordHash|token|accessToken|authorization|secret|buyerEmail|email|buyerName|jwt)$/i;
  const walk = (value, trail) => {
    if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${trail}[${i}]`));
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.test(k)) {
          // único caso permitido: el email enmascarado de un login fallido
          assert.ok(k === "email" && typeof v === "string" && /^.\*\*\*@/.test(v), `clave prohibida ${trail}.${k}`);
        }
        walk(v, `${trail}.${k}`);
      }
    }
  };
  for (const row of all) walk(row.details, `${row.action}#${row.id}.details`);

  const text = await allRowsText();
  const secrets = [
    ADMIN_PASSWORD, NEW_USER_PASSWORD, CHANGED_PASSWORD, STAFF_PASSWORD, ORG_PASSWORD, MP_TOKEN, "APP_USR", BUYER_EMAIL,
    "Comprador Privado", LOGIN_EMAIL, "admin@test.com", "org@test.com", "staff@test.com", accB.id, "data:image",
    process.env.MERCADOPAGO_ACCESS_TOKEN, process.env.JWT_SECRET, "$2a$", "$2b$",
  ];
  for (const s of secrets) assert.ok(!text.includes(s), `la auditoría contiene ${s}`);
  for (const p of await Purchase.findAll()) assert.ok(!text.includes(p.accessToken), "contiene un accessToken de compra");
  for (const u of await User.findAll()) assert.ok(!text.includes(u.password), "contiene un hash de contraseña");
});

test("todas las filas tienen action, result válido y las de un usuario autenticado traen ip", async () => {
  const all = await AuditLog.findAll();
  for (const r of all) {
    assert.ok(r.action);
    assert.ok(["success", "failure", "denied"].includes(r.result));
    assert.ok(r.createdAt);
    if (r.actorId && r.action !== "TEST_NORMALIZE") assert.ok(r.ip, `${r.action} sin ip`);
  }
});
