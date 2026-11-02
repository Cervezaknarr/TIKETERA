// Tests de lotes con código de acceso y eventos para mayores de 18, con SQLite en memoria
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

let server;
let baseUrl;
let owner;
let adminToken;

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

const newEvent = async (fields = {}) => {
  const event = await Event.create({
    title: "Evento",
    description: "Prueba",
    date: new Date(Date.now() + 86400000),
    location: "Club",
    userId: owner.id,
    ...fields,
  });
  const lot = (name, price, quantity, accessCode) =>
    Lot.create({ eventId: event.id, name, price, quantity, ticketsAvailable: quantity, accessCode });
  event.general = await lot("General", 1000, 50);
  event.player = await lot("Jugador", 100, 5, "JUGADORES");
  return event;
};

const checkout = (event, items, extra = {}) =>
  call("POST", "/api/purchases/checkout", {
    body: { eventId: event.id, buyerName: "Ana", buyerEmail: "ana@test.com", items, ...extra },
  });

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

test("el público no ve los lotes con código, ni el código, en el evento ni en el listado", async () => {
  const event = await newEvent();

  const one = await call("GET", `/api/events/${event.id}`);
  assert.deepEqual(one.body.event.lots.map((l) => l.name), ["General"]);
  assert.equal(one.body.event.hasCodeLots, true);
  assert.equal(one.body.event.ticketsAvailable, 50);

  const list = await call("GET", "/api/events?limit=100");
  const listed = list.body.events.find((e) => e.id === event.id);
  assert.deepEqual(listed.lots.map((l) => l.name), ["General"]);
  assert.ok(!JSON.stringify([one.body, list.body]).includes("JUGADORES"));
});

test("el administrador ve los lotes con su código", async () => {
  const event = await newEvent();
  const res = await call("GET", `/api/events/${event.id}`, { token: adminToken });
  assert.deepEqual(res.body.event.lots.map((l) => l.accessCode), [null, "JUGADORES"]);
  assert.equal(res.body.event.ticketsAvailable, 55);
});

test("un evento sin lotes con código no ofrece ingresar uno, ni si se agotaron", async () => {
  const event = await newEvent();
  await event.player.update({ ticketsAvailable: 0 });
  const res = await call("GET", `/api/events/${event.id}`);
  assert.equal(res.body.event.hasCodeLots, false);
});

test("el código correcto habilita el lote, sin importar mayúsculas ni espacios", async () => {
  const event = await newEvent();
  const res = await call("POST", `/api/events/${event.id}/unlock`, { body: { code: "  jugadores " } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.lots.map((l) => l.name), ["Jugador"]);
  assert.equal(res.body.lots[0].accessCode, undefined);
});

test("un código incorrecto, vacío o de otro tipo no habilita nada", async () => {
  const event = await newEvent();
  for (const code of ["OTRO", "", null, undefined, 123, { a: 1 }]) {
    const res = await call("POST", `/api/events/${event.id}/unlock`, { body: { code } });
    assert.equal(res.status, 400, `código ${JSON.stringify(code)}`);
  }
  const garbage = await call("POST", "/api/events/no-es-un-id/unlock", { body: { code: "JUGADORES" } });
  assert.equal(garbage.status, 400);
});

test("un evento en borrador no revela sus lotes aunque el código sea correcto", async () => {
  const event = await newEvent({ status: "draft" });
  const res = await call("POST", `/api/events/${event.id}/unlock`, { body: { code: "JUGADORES" } });
  assert.equal(res.status, 400);
});

test("el código de un evento no sirve en otro", async () => {
  const second = await newEvent();
  await second.player.update({ accessCode: "OTROCODIGO" });
  const res = await checkout(second, [{ lotId: second.player.id, quantity: 1, code: "JUGADORES" }]);
  assert.equal(res.status, 403);
});

test("no se puede comprar un lote con código sin el código, ni con uno incorrecto", async () => {
  const event = await newEvent();
  for (const code of [undefined, "", "MAL", 5]) {
    const res = await checkout(event, [{ lotId: event.player.id, quantity: 1, code }]);
    assert.equal(res.status, 403);
  }
  // Tampoco repitiendo el lote: una línea con código y otra sin él
  const mixed = await checkout(event, [
    { lotId: event.player.id, quantity: 1, code: "JUGADORES" },
    { lotId: event.player.id, quantity: 1 },
  ]);
  assert.equal(mixed.status, 403);
  // Tampoco con el formato anterior, de un solo lote
  const legacy = await call("POST", "/api/purchases/checkout", {
    body: { eventId: event.id, buyerName: "Ana", buyerEmail: "ana@test.com", lotId: event.player.id, quantity: 1 },
  });
  assert.equal(legacy.status, 403);
  assert.equal((await Lot.findByPk(event.player.id)).ticketsAvailable, 5);
});

test("un evento con un solo lote, con código, no se vende omitiendo el lote", async () => {
  const event = await Event.create({
    title: "Solo jugadores", description: "x", date: new Date(Date.now() + 86400000), location: "Club", userId: owner.id,
  });
  await Lot.create({ eventId: event.id, name: "Jugador", price: 100, quantity: 5, ticketsAvailable: 5, accessCode: "JUGADORES" });
  const res = await call("POST", "/api/purchases/checkout", {
    body: { eventId: event.id, buyerName: "Ana", buyerEmail: "ana@test.com", quantity: 1 },
  });
  assert.equal(res.status, 403);
});

test("con el código se compra al precio del lote y se puede combinar con otro público", async () => {
  const event = await newEvent();
  const res = await checkout(event, [
    { lotId: event.player.id, quantity: 2, code: "jugadores" },
    { lotId: event.general.id, quantity: 1 },
  ]);
  assert.equal(res.status, 201);
  assert.equal(Number(res.body.purchase.totalPrice), 1200);
  assert.equal((await Lot.findByPk(event.player.id)).ticketsAvailable, 3);
});

test("el administrador pone, normaliza, valida y quita el código de un lote", async () => {
  const event = await newEvent();
  const url = `/api/events/${event.id}/lots/${event.general.id}`;

  const set = await call("PUT", url, { token: adminToken, body: { accessCode: " prensa-1 " } });
  assert.equal(set.body.lot.accessCode, "PRENSA-1");

  for (const accessCode of ["abc", "con espacio", "x".repeat(41), 1234]) {
    const bad = await call("PUT", url, { token: adminToken, body: { accessCode } });
    assert.equal(bad.status, 400, `código ${accessCode}`);
  }

  // Editar otro dato no toca el código
  const other = await call("PUT", url, { token: adminToken, body: { price: 900 } });
  assert.equal(other.body.lot.accessCode, "PRENSA-1");

  const cleared = await call("PUT", url, { token: adminToken, body: { accessCode: "" } });
  assert.equal(cleared.body.lot.accessCode, null);
});

test("el evento se crea con un lote con código y las respuestas del admin lo muestran", async () => {
  const res = await call("POST", "/api/events", {
    token: adminToken,
    body: {
      title: "Con código",
      description: "x",
      date: new Date(Date.now() + 86400000).toISOString(),
      location: "Club",
      status: "published",
      adultsOnly: true,
      lots: [
        { name: "General", price: 1000, quantity: 5, accessCode: "" },
        { name: "Jugador", price: 100, quantity: 5, accessCode: "jugadores" },
      ],
    },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.event.adultsOnly, true);
  assert.deepEqual(res.body.event.lots.map((l) => l.accessCode), [null, "JUGADORES"]);
});

test("un evento +18 exige aceptar la edad; los demás no", async () => {
  const adults = await newEvent({ adultsOnly: true });
  const items = [{ lotId: adults.general.id, quantity: 1 }];

  for (const extra of [{}, { ageConfirmed: false }, { ageConfirmed: "true" }]) {
    const res = await checkout(adults, items, extra);
    assert.equal(res.status, 400);
  }
  assert.equal((await Lot.findByPk(adults.general.id)).ticketsAvailable, 50);
  assert.equal((await checkout(adults, items, { ageConfirmed: true })).status, 201);

  const regular = await newEvent();
  assert.equal((await checkout(regular, [{ lotId: regular.general.id, quantity: 1 }])).status, 201);
});

test("el admin activa y desactiva +18; el público lo ve; un valor inválido se rechaza", async () => {
  const event = await newEvent();
  const on = await call("PUT", `/api/events/${event.id}`, { token: adminToken, body: { adultsOnly: true } });
  assert.equal(on.body.event.adultsOnly, true);
  assert.equal((await call("GET", `/api/events/${event.id}`)).body.event.adultsOnly, true);

  const bad = await call("PUT", `/api/events/${event.id}`, { token: adminToken, body: { adultsOnly: "si" } });
  assert.equal(bad.status, 400);

  const off = await call("PUT", `/api/events/${event.id}`, { token: adminToken, body: { adultsOnly: false } });
  assert.equal(off.body.event.adultsOnly, false);
});
