// Tandas secuenciales en el checkout (TT.03) con SQLite en memoria
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
const Pack = require("../models/Pack");
const Purchase = require("../models/Purchase");

let server;
let baseUrl;
let owner;
let n = 0;

const checkout = async (event, body) => {
  const res = await fetch(`${baseUrl}/api/purchases/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      eventId: event.id,
      buyerName: "Ana Pérez",
      buyerEmail: `ana${++n}@test.com`,
      ...body,
    }),
  });
  return { status: res.status, body: await res.json() };
};

// Evento con cadena de 2 tandas (la 2.ª con afterPrevious) (cupo 10 y 10), un VIP suelto y un pack de 2 de la tanda 2
const newEvent = async (tiers = true) => {
  const event = await Event.create({
    title: "Evento",
    description: "Prueba",
    date: new Date(Date.now() + 86400000),
    location: "Salón",
    userId: owner.id,
  });
  const lot = (name, position, afterPrevious, price = 1000) =>
    Lot.create({
      eventId: event.id, name, price, quantity: 10, ticketsAvailable: 10, position,
      afterPrevious: tiers ? afterPrevious : false,
    });
  event.t1 = await lot("General 1.ª tanda", 0, false);
  event.t2 = await lot("General 2.ª tanda", 1, true, 1300);
  event.vip = await lot("VIP", 2, false, 3000);
  event.pack = await Pack.create({
    eventId: event.id, lotId: event.t2.id, quantity: 2, discountPercent: 10,
  });
  return event;
};

const left = async (lot) => (await Lot.findByPk(lot.id)).ticketsAvailable;
const purchases = (event) => Purchase.count({ where: { eventId: event.id } });

before(async () => {
  await sequelize.sync({ force: true });
  owner = await User.create({ name: "Org", email: "org@test.com", password: "secret", role: "admin" });
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await sequelize.close();
});

test("comprar la tanda 2 con la 1 con cupo da 409 LOT_LOCKED sin tocar nada", async () => {
  const event = await newEvent();
  const res = await checkout(event, { items: [{ lotId: event.t2.id, quantity: 1 }] });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "LOT_LOCKED");
  assert.match(res.body.message, /General 2\.ª tanda/);
  assert.equal(await left(event.t2), 10);
  assert.equal(await left(event.t1), 10);
  assert.equal(await purchases(event), 0);
});

test("la tanda 1 se compra; mezclar con la tanda 2 se rechaza entero", async () => {
  const event = await newEvent();
  const ok = await checkout(event, { items: [{ lotId: event.t1.id, quantity: 2 }] });
  assert.equal(ok.status, 201);
  assert.equal(await left(event.t1), 8);

  const mix = await checkout(event, {
    items: [{ lotId: event.t1.id, quantity: 1 }, { lotId: event.t2.id, quantity: 1 }],
  });
  assert.equal(mix.status, 409);
  assert.equal(mix.body.code, "LOT_LOCKED");
  assert.equal(await left(event.t1), 8);
  assert.equal(await purchases(event), 1);
});

test("al agotar la tanda 1 la tanda 2 se puede comprar", async () => {
  const event = await newEvent();
  assert.equal((await checkout(event, { items: [{ lotId: event.t1.id, quantity: 10 }] })).status, 201);
  assert.equal(await left(event.t1), 0);
  const res = await checkout(event, { items: [{ lotId: event.t2.id, quantity: 3 }] });
  assert.equal(res.status, 201);
  assert.equal(await left(event.t2), 7);
});

test("pedir más de lo que queda en la tanda 1 no desborda a la tanda 2", async () => {
  const event = await newEvent();
  await event.t1.update({ ticketsAvailable: 2 });
  const res = await checkout(event, { items: [{ lotId: event.t1.id, quantity: 5 }] });
  assert.equal(res.status, 400);
  assert.equal(await left(event.t1), 2);
  assert.equal(await left(event.t2), 10);
});

test("un lote suelto al lado siempre se puede comprar", async () => {
  const event = await newEvent();
  const res = await checkout(event, { items: [{ lotId: event.vip.id, quantity: 1 }] });
  assert.equal(res.status, 201);
  assert.equal(await left(event.vip), 9);
});

test("un pack de una tanda bloqueada da 409 y no reserva", async () => {
  const event = await newEvent();
  const res = await checkout(event, { packs: [{ packId: event.pack.id, count: 1 }] });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "LOT_LOCKED");
  assert.equal(await left(event.t2), 10);
  assert.equal(await purchases(event), 0);

  await event.t1.update({ ticketsAvailable: 0 });
  const ok = await checkout(event, { packs: [{ packId: event.pack.id, count: 1 }] });
  assert.equal(ok.status, 201);
  assert.equal(await left(event.t2), 8);
});

test("un evento sin tandas se comporta como antes", async () => {
  const event = await newEvent(false);
  const res = await checkout(event, { items: [{ lotId: event.t2.id, quantity: 1 }] });
  assert.equal(res.status, 201);
  assert.equal(await left(event.t2), 9);
});
