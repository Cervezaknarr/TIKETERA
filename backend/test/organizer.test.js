// Rol organizador: compradores, staff, escáner y pagos de SU evento, con SQLite en memoria
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
const PaymentAccount = require("../models/PaymentAccount");

const TOKEN_A = "APP_USR-cuenta-org-a-1111111";
const TOKEN_B = "APP_USR-cuenta-org-b-2222222";
const TOKEN_X = "APP_USR-cuenta-org-x-3333333";

let server;
let baseUrl;
let admin;
let orgA; // organizador del evento A
let orgB; // organizador del evento B
let generalStaff; // staff general (creado por el admin)
let eventA;
let eventB;
let eventFree; // sin organizador
const tokens = {};

const realFetch = globalThis.fetch;
let mpCalls = [];
let lastPreferenceToken = null;

const sign = (user) => jwt.sign({ id: user.id, v: user.tokenVersion }, process.env.JWT_SECRET);
const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const as = (who, method, path, body) => call(method, path, { token: tokens[who], body });

const newEvent = async (title, organizerId = null) => {
  const event = await Event.create({
    title, description: "Prueba", date: new Date(Date.now() + 86400000),
    location: "Salón", userId: admin.id, organizerId,
  });
  event.lot = await Lot.create({ eventId: event.id, name: "General", price: 1000, quantity: 100, ticketsAvailable: 100 });
  return event;
};

const checkout = (event) =>
  call("POST", "/api/purchases/checkout", {
    body: { eventId: event.id, lotId: event.lot.id, buyerName: "Comprador", buyerEmail: "c@test.com", quantity: 1 },
  });

before(async () => {
  await sequelize.sync({ force: true });
  admin = await User.create({ name: "Admin", email: "admin@test.com", password: "secret123", role: "admin" });
  orgA = await User.create({ name: "Org A", email: "orga@test.com", password: "secret123", role: "organizer" });
  orgB = await User.create({ name: "Org B", email: "orgb@test.com", password: "secret123", role: "organizer" });
  generalStaff = await User.create({ name: "Puerta", email: "puerta@test.com", password: "secret123", role: "staff" });
  Object.assign(tokens, { admin: sign(admin), orgA: sign(orgA), orgB: sign(orgB), staff: sign(generalStaff) });

  eventA = await newEvent("Evento A", orgA.id);
  eventB = await newEvent("Evento B", orgB.id);
  eventFree = await newEvent("Evento libre");

  globalThis.fetch = async (url, options = {}) => {
    if (!String(url).startsWith("https://api.mercadopago.com")) return realFetch(url, options);
    mpCalls.push({ url: String(url), options });
    if (String(url).endsWith("/users/me")) return new Response(JSON.stringify({ id: 1 }));
    if (String(url).endsWith("/checkout/preferences")) {
      lastPreferenceToken = options.headers.Authorization;
      return new Response(JSON.stringify({ init_point: "https://mp.test/pagar" }));
    }
    return new Response("{}", { status: 404 });
  };

  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  globalThis.fetch = realFetch;
  server.close();
  await sequelize.close();
});

test("el admin crea un organizador y lo asigna a un evento; el login lo reconoce", async () => {
  const created = await as("admin", "POST", "/api/users", {
    name: "Nuevo Org", email: "Nuevo@Test.com", password: "secret123", role: "organizer",
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.user.role, "organizer");
  assert.equal(created.body.user.email, "nuevo@test.com");

  const login = await call("POST", "/api/auth/login", { body: { email: "nuevo@test.com", password: "secret123" } });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, "organizer");

  const event = await as("admin", "POST", "/api/events", {
    title: "Con organizador", description: "x", location: "Club", status: "published",
    date: new Date(Date.now() + 86400000).toISOString(),
    organizerId: created.body.user.id,
    lots: [{ name: "General", price: 1000, quantity: 10 }],
  });
  assert.equal(event.status, 201);
  assert.equal(event.body.event.organizerId, created.body.user.id);

  // Mandar role admin nunca crea un admin: se crea staff
  const notAdmin = await as("admin", "POST", "/api/users", { name: "x", email: "x@t.com", password: "secret123", role: "admin" });
  assert.equal(notAdmin.body.user.role, "staff");
  // Un usuario que no es organizador no se puede asignar a un evento
  const bad = await as("admin", "PUT", `/api/events/${event.body.event.id}`, { organizerId: generalStaff.id });
  assert.equal(bad.status, 400);
  const badId = await as("admin", "PUT", `/api/events/${event.body.event.id}`, { organizerId: "no-es-uuid" });
  assert.equal(badId.status, 400);
});

test("el organizador no puede usar las rutas de administración", async () => {
  for (const [method, path, body] of [
    ["POST", "/api/events", { title: "x" }],
    ["PUT", `/api/events/${eventA.id}`, { title: "Hackeado" }],
    ["DELETE", `/api/events/${eventA.id}`],
    ["GET", "/api/users"],
    ["POST", "/api/users", { name: "x", email: "y@t.com", password: "secret123", role: "organizer" }],
    ["GET", "/api/payment-accounts"],
    ["PUT", "/api/payment-accounts/sales-paused", { paused: true }],
    ["POST", `/api/events/${eventA.id}/lots`, { name: "L", price: 1, quantity: 1 }],
    ["POST", `/api/events/${eventA.id}/packs`, { lotId: eventA.lot.id, quantity: 5, discountPercent: 5 }],
  ]) {
    assert.equal((await as("orgA", method, path, body)).status, 403, `${method} ${path}`);
  }
  assert.equal((await Event.findByPk(eventA.id)).title, "Evento A");
});

test("el organizador ve solo sus eventos y los datos internos no se filtran al público", async () => {
  const mine = await as("orgA", "GET", "/api/organizer/events");
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.events.map((e) => e.id), [eventA.id]);

  // El staff y los visitantes no entran al panel del organizador
  assert.equal((await as("staff", "GET", "/api/organizer/events")).status, 403);
  assert.equal((await call("GET", "/api/organizer/events")).status, 401);

  const pub = await call("GET", `/api/events/${eventA.id}`);
  assert.equal(pub.body.event.organizerId, undefined);
  assert.equal(pub.body.event.paymentAccountId, undefined);
  assert.equal(pub.body.event.salesPaused, false);
  // El admin sí ve a quién está asignado
  assert.equal((await as("admin", "GET", `/api/events/${eventA.id}`)).body.event.organizerId, orgA.id);
});

test("el organizador ve los compradores de su evento y no los de otro", async () => {
  await Purchase.create({
    eventId: eventA.id, lotId: eventA.lot.id, lotName: "General", unitPrice: 1000,
    buyerEmail: "comprador@test.com", buyerName: "Ana", quantity: 1, totalPrice: 1000, status: "completed",
  });
  const own = await as("orgA", "GET", `/api/purchases/event/${eventA.id}`);
  assert.equal(own.status, 200);
  assert.equal(own.body.purchases.length, 1);
  assert.equal(own.body.purchases[0].buyerEmail, "comprador@test.com");

  assert.equal((await as("orgA", "GET", `/api/purchases/event/${eventB.id}`)).status, 403);
  assert.equal((await as("orgA", "GET", `/api/purchases/event/${eventFree.id}`)).status, 403);
  assert.equal((await as("staff", "GET", `/api/purchases/event/${eventA.id}`)).status, 403);
  assert.equal((await as("admin", "GET", `/api/purchases/event/${eventA.id}`)).status, 200);
  assert.equal((await as("orgA", "GET", "/api/purchases/event/00000000-0000-4000-8000-000000000000")).status, 404);
});

test("el organizador crea staff solo para su evento, y solo puede gestionar el suyo", async () => {
  const created = await as("orgA", "POST", `/api/organizer/events/${eventA.id}/staff`, {
    name: "Puerta A", email: "puertaa@test.com", password: "secret123",
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.user.eventId, eventA.id);
  const staffA = await User.findByPk(created.body.user.id);
  assert.equal(staffA.role, "staff");
  tokens.staffA = sign(staffA);

  // No puede crear staff en un evento ajeno
  assert.equal((await as("orgA", "POST", `/api/organizer/events/${eventB.id}/staff`, {
    name: "Intruso", email: "intruso@test.com", password: "secret123",
  })).status, 403);
  assert.equal(await User.count({ where: { email: "intruso@test.com" } }), 0);

  // Validaciones
  assert.equal((await as("orgA", "POST", `/api/organizer/events/${eventA.id}/staff`, {
    name: "x", email: "corta@test.com", password: "123",
  })).status, 400);
  assert.equal((await as("orgA", "POST", `/api/organizer/events/${eventA.id}/staff`, {
    name: "x", email: "puertaa@test.com", password: "secret123",
  })).status, 400);

  // Lista: solo el staff de su evento (no el general ni el de otros)
  const list = await as("orgA", "GET", `/api/organizer/events/${eventA.id}/staff`);
  assert.deepEqual(list.body.users.map((u) => u.email), ["puertaa@test.com"]);

  // Otro organizador no puede tocar ese staff, ni con su propio :eventId
  const staffB = await as("orgB", "POST", `/api/organizer/events/${eventB.id}/staff`, {
    name: "Puerta B", email: "puertab@test.com", password: "secret123",
  });
  for (const [method, body] of [["PUT", { password: "nuevaclave123" }], ["DELETE"]]) {
    assert.equal((await as("orgB", method, `/api/organizer/events/${eventB.id}/staff/${staffA.id}`, body)).status, 404);
    assert.equal((await as("orgB", method, `/api/organizer/events/${eventA.id}/staff/${staffA.id}`, body)).status, 403);
  }
  assert.ok(await User.findByPk(staffA.id));
  // ni el staff general del admin
  assert.equal((await as("orgA", "DELETE", `/api/organizer/events/${eventA.id}/staff/${generalStaff.id}`)).status, 404);

  // Cambiar la contraseña del suyo corta su sesión
  assert.equal((await as("orgA", "PUT", `/api/organizer/events/${eventA.id}/staff/${staffA.id}`, { password: "nuevaclave123" })).status, 200);
  assert.equal((await as("staffA", "GET", "/api/checkin/my-events")).status, 401);
  assert.ok(staffB.body.user.id);
});

test("escanear: cada uno solo en los eventos que le corresponden", async () => {
  const staffA = await User.findOne({ where: { email: "puertaa@test.com" } });
  tokens.staffA = sign(await staffA.reload());

  const stats = (who, event) => as(who, "GET", `/api/checkin/events/${event.id}/stats`);
  // staff de A: solo A
  assert.equal((await stats("staffA", eventA)).status, 200);
  assert.equal((await stats("staffA", eventB)).status, 403);
  assert.equal((await as("staffA", "POST", `/api/checkin/events/${eventB.id}/sync`, { deviceId: "d", scans: [] })).status, 403);
  // organizador: solo sus eventos
  assert.equal((await stats("orgA", eventA)).status, 200);
  assert.equal((await stats("orgA", eventB)).status, 403);
  // staff general y admin: todos
  assert.equal((await stats("staff", eventB)).status, 200);
  assert.equal((await stats("admin", eventA)).status, 200);

  // El selector del escáner solo lista lo que cada uno puede escanear
  await Event.update({ status: "published" }, { where: {} });
  const ids = async (who) => (await as(who, "GET", "/api/checkin/my-events")).body.events.map((e) => e.id).sort();
  assert.deepEqual(await ids("staffA"), [eventA.id]);
  assert.deepEqual(await ids("orgA"), [eventA.id]);
  assert.deepEqual(await ids("orgB"), [eventB.id]);
  assert.ok((await ids("staff")).includes(eventB.id));
  assert.ok((await ids("admin")).includes(eventA.id));
});

test("el organizador agrega una cuenta de Mercado Pago propia: se verifica, se cifra y es solo de su evento", async () => {
  mpCalls = [];
  const res = await as("orgA", "POST", `/api/organizer/events/${eventA.id}/payments/accounts`, { name: "Mi cuenta", accessToken: TOKEN_A });
  assert.equal(res.status, 201);
  assert.ok(!JSON.stringify(res.body).includes(TOKEN_A));
  assert.equal(mpCalls[0].url, "https://api.mercadopago.com/users/me");

  const stored = await PaymentAccount.findByPk(res.body.account.id);
  assert.equal(stored.eventId, eventA.id);
  assert.ok(!stored.accessToken.includes(TOKEN_A));

  // No puede cargarla en un evento ajeno
  assert.equal((await as("orgA", "POST", `/api/organizer/events/${eventB.id}/payments/accounts`, { name: "x", accessToken: TOKEN_X })).status, 403);

  // No aparece en el panel general del admin ni en el de otro organizador
  assert.deepEqual((await as("admin", "GET", "/api/payment-accounts")).body.accounts, []);
  assert.deepEqual((await as("orgB", "GET", `/api/organizer/events/${eventB.id}/payments`)).body.accounts, []);
  const mine = await as("orgA", "GET", `/api/organizer/events/${eventA.id}/payments`);
  assert.equal(mine.body.accounts.length, 1);
  assert.equal(mine.body.accounts[0].active, false);
  assert.ok(!JSON.stringify(mine.body).includes(TOKEN_A));
});

test("cambiar de cuenta exige pausar las ventas del evento, y el evento cobra con su cuenta", async () => {
  const [accountA] = await PaymentAccount.findAll({ where: { eventId: eventA.id } });
  const activate = (who, event, id) => as(who, "POST", `/api/organizer/events/${event.id}/payments/accounts/${id}/activate`);

  // Sin pausar: rechazado
  assert.equal((await activate("orgA", eventA, accountA.id)).status, 409);

  // Pausar frena las compras de ESE evento, no las de otros
  assert.equal((await as("orgA", "PUT", `/api/organizer/events/${eventA.id}/sales-paused`, { paused: true })).status, 200);
  assert.equal((await checkout(eventA)).status, 503);
  assert.equal((await checkout(eventB)).status, 201);
  assert.equal((await as("orgA", "PUT", `/api/organizer/events/${eventA.id}/sales-paused`, { paused: "si" })).status, 400);
  assert.equal((await as("orgB", "PUT", `/api/organizer/events/${eventA.id}/sales-paused`, { paused: false })).status, 403);

  // Pausado: puede activar su cuenta; la de otro evento no
  const accountB = (await as("orgB", "POST", `/api/organizer/events/${eventB.id}/payments/accounts`, { name: "B", accessToken: TOKEN_B })).body.account;
  assert.equal((await activate("orgA", eventA, accountB.id)).status, 404);
  assert.equal((await activate("orgB", eventA, accountA.id)).status, 403);
  assert.equal((await activate("orgA", eventA, accountA.id)).status, 200);
  assert.equal((await Event.findByPk(eventA.id)).paymentAccountId, accountA.id);

  // Reanudar: la compra usa el token de la cuenta del evento (y queda registrada en la compra)
  await as("orgA", "PUT", `/api/organizer/events/${eventA.id}/sales-paused`, { paused: false });
  lastPreferenceToken = null;
  const bought = await checkout(eventA);
  assert.equal(bought.status, 201);
  assert.equal(lastPreferenceToken, `Bearer ${TOKEN_A}`);
  assert.equal((await Purchase.findByPk(bought.body.purchase.id)).paymentAccountId, accountA.id);

  // Un evento sin cuenta propia sigue cobrando con la general de la plataforma
  lastPreferenceToken = null;
  assert.equal((await checkout(eventFree)).status, 201);
  assert.equal(lastPreferenceToken, `Bearer ${process.env.MERCADOPAGO_ACCESS_TOKEN}`);
});

test("borrar cuentas: no la activa ni la que ya cobró; solo las propias", async () => {
  const [accountA] = await PaymentAccount.findAll({ where: { eventId: eventA.id } });
  const del = (who, event, id) => as(who, "DELETE", `/api/organizer/events/${event.id}/payments/accounts/${id}`);

  assert.equal((await del("orgA", eventA, accountA.id)).status, 409); // activa
  const extra = (await as("orgA", "POST", `/api/organizer/events/${eventA.id}/payments/accounts`, { name: "Extra", accessToken: TOKEN_X })).body.account;
  assert.equal((await del("orgB", eventA, extra.id)).status, 403);
  assert.equal((await del("orgB", eventB, extra.id)).status, 404); // de otro evento
  assert.equal((await del("orgA", eventA, extra.id)).status, 200);
  assert.equal(await PaymentAccount.count({ where: { id: extra.id } }), 0);

  // El admin no puede borrar ni activar cuentas de un evento desde el panel general
  assert.equal((await as("admin", "DELETE", `/api/payment-accounts/${accountA.id}`)).status, 404);
  await as("admin", "PUT", "/api/payment-accounts/sales-paused", { paused: true });
  assert.equal((await as("admin", "POST", `/api/payment-accounts/${accountA.id}/activate`)).status, 404);
  await as("admin", "PUT", "/api/payment-accounts/sales-paused", { paused: false });
});

test("borrar un organizador deja sus eventos sin organizador", async () => {
  const gone = await User.create({ name: "Se va", email: "sevasale@test.com", password: "secret123", role: "organizer" });
  const event = await newEvent("De quien se va", gone.id);
  assert.equal((await as("admin", "DELETE", `/api/users/${gone.id}`)).status, 200);
  assert.equal((await Event.findByPk(event.id)).organizerId, null);
});
