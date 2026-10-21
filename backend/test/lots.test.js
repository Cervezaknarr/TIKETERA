// Tests de edición de eventos y lotes (tipos de entrada), con SQLite en memoria
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
const Purchase = require("../models/Purchase");
const { migrateEventsToLots } = require("../utils/migrateLots");

let server;
let baseUrl;
let ownerToken;
let otherToken;

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

const eventBody = (lots) => ({
  title: "Fiesta",
  description: "Prueba",
  date: new Date(Date.now() + 86400000).toISOString(),
  location: "Club",
  lots,
});

const defaultLots = () => [
  { name: "EARLY", price: 1000, quantity: 10 },
  { name: "VIP", price: 5000, quantity: 5 },
  { name: "General", price: 2000, quantity: 20 },
];

// Crea un evento del organizador y devuelve { event, lot(name) }
const newEvent = async (lots = defaultLots()) => {
  const { body } = await call("POST", "/api/events", { token: ownerToken, body: eventBody(lots) });
  return { event: body.event, lot: (name) => body.event.lots.find((l) => l.name === name) };
};

const buy = (event, lot, quantity, name = "Comprador") =>
  call("POST", "/api/purchases/checkout", {
    body: {
      eventId: event.id,
      lotId: lot && lot.id,
      buyerName: name,
      buyerEmail: "comprador@test.com",
      quantity,
    },
  });

const available = async (lot) => (await Lot.findByPk(lot.id)).ticketsAvailable;

before(async () => {
  await sequelize.sync({ force: true });
  const owner = await User.create({ name: "Org", email: "org@test.com", password: "secret" });
  const other = await User.create({ name: "Otro", email: "otro@test.com", password: "secret" });
  ownerToken = jwt.sign({ id: owner.id }, process.env.JWT_SECRET);
  otherToken = jwt.sign({ id: other.id }, process.env.JWT_SECRET);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await sequelize.close();
});

test("un evento se crea con sus lotes, en orden, y suma el cupo total", async () => {
  const { event } = await newEvent();

  assert.deepEqual(
    event.lots.map((l) => [l.name, Number(l.price), l.quantity, l.ticketsAvailable]),
    [
      ["EARLY", 1000, 10, 10],
      ["VIP", 5000, 5, 5],
      ["General", 2000, 20, 20],
    ]
  );
  assert.equal(event.ticketsAvailable, 35);

  // El listado público también trae los lotes
  const list = await call("GET", "/api/events");
  assert.equal(list.body.events.find((e) => e.id === event.id).lots.length, 3);
});

test("el formato anterior (precio y cupo únicos) crea un lote General", async () => {
  const { status, body } = await call("POST", "/api/events", {
    token: ownerToken,
    body: { ...eventBody(undefined), lots: undefined, ticketPrice: 1500, ticketsAvailable: 50 },
  });
  assert.equal(status, 201);
  assert.equal(body.event.lots.length, 1);
  assert.equal(body.event.lots[0].name, "General");
  assert.equal(Number(body.event.lots[0].price), 1500);
  assert.equal(body.event.ticketsAvailable, 50);
});

test("crear un evento valida los lotes", async () => {
  const invalid = {
    "sin lotes": [],
    "nombre vacío": [{ name: " ", price: 100, quantity: 5 }],
    "precio negativo": [{ name: "A", price: -1, quantity: 5 }],
    "precio no numérico": [{ name: "A", price: "gratis", quantity: 5 }],
    "cantidad 0": [{ name: "A", price: 100, quantity: 0 }],
    "cantidad decimal": [{ name: "A", price: 100, quantity: 1.5 }],
    "nombres repetidos": [
      { name: "VIP", price: 100, quantity: 5 },
      { name: "vip", price: 200, quantity: 5 },
    ],
  };
  const before = await Event.count();
  for (const [label, lots] of Object.entries(invalid)) {
    const res = await call("POST", "/api/events", { token: ownerToken, body: eventBody(lots) });
    assert.equal(res.status, 400, label);
  }
  assert.equal(await Event.count(), before);

  const unauthenticated = await call("POST", "/api/events", { body: eventBody(defaultLots()) });
  assert.equal(unauthenticated.status, 401);
});

test("solo el organizador edita el evento y sus lotes", async () => {
  const { event, lot } = await newEvent();
  const vip = lot("VIP");

  const attempts = [
    ["PUT", `/api/events/${event.id}`, { title: "Hackeado" }],
    ["POST", `/api/events/${event.id}/lots`, { name: "Nuevo", price: 1, quantity: 1 }],
    ["PUT", `/api/events/${event.id}/lots/${vip.id}`, { price: 1 }],
    ["DELETE", `/api/events/${event.id}/lots/${vip.id}`],
  ];
  for (const [method, path, body] of attempts) {
    const other = await call(method, path, { token: otherToken, body });
    assert.equal(other.status, 403, `${method} ${path} con otro usuario`);
    const anonymous = await call(method, path, { body });
    assert.equal(anonymous.status, 401, `${method} ${path} sin sesión`);
  }

  const unchanged = await call("GET", `/api/events/${event.id}`);
  assert.equal(unchanged.body.event.title, "Fiesta");
  assert.equal(unchanged.body.event.lots.length, 3);
  assert.equal(Number(unchanged.body.event.lots.find((l) => l.name === "VIP").price), 5000);
});

test("el organizador edita los datos del evento", async () => {
  const { event } = await newEvent();

  const res = await call("PUT", `/api/events/${event.id}`, {
    token: ownerToken,
    body: { title: "Fiesta 2", location: "Otro club", status: "draft" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.event.title, "Fiesta 2");
  assert.equal(res.body.event.location, "Otro club");
  assert.equal(res.body.event.status, "draft");
  assert.equal(res.body.event.description, "Prueba"); // lo no enviado no cambia
  assert.equal(res.body.event.lots.length, 3);

  for (const body of [{ title: " " }, { date: "no-es-fecha" }, { status: "otro" }]) {
    const bad = await call("PUT", `/api/events/${event.id}`, { token: ownerToken, body });
    assert.equal(bad.status, 400, JSON.stringify(body));
  }
});

test("un evento que no está publicado no vende entradas", async () => {
  const { event, lot } = await newEvent();
  await call("PUT", `/api/events/${event.id}`, { token: ownerToken, body: { status: "draft" } });

  const res = await buy(event, lot("VIP"), 1);
  assert.equal(res.status, 400);
  assert.equal(await available(lot("VIP")), 5);
});

test("cada lote tiene su precio y su cupo", async () => {
  const { event, lot } = await newEvent();

  const vip = await buy(event, lot("VIP"), 2);
  assert.equal(vip.status, 201);
  assert.equal(Number(vip.body.purchase.totalPrice), 10000);
  assert.equal(vip.body.purchase.lotName, "VIP");

  assert.equal(await available(lot("VIP")), 3);
  assert.equal(await available(lot("EARLY")), 10);
  assert.equal(await available(lot("General")), 20);
});

test("con varios lotes hay que elegir uno, y tiene que ser del evento", async () => {
  const { event, lot } = await newEvent();
  const { lot: otherLot } = await newEvent();

  const none = await buy(event, null, 1);
  assert.equal(none.status, 400);
  assert.match(none.body.message, /Elegí un tipo de entrada/);

  const foreign = await buy(event, otherLot("VIP"), 1);
  assert.equal(foreign.status, 400);
  assert.match(foreign.body.message, /no pertenece/);
  assert.equal(await available(otherLot("VIP")), 5);

  // Con un solo lote no hace falta indicarlo
  const { event: single } = await newEvent([{ name: "Única", price: 100, quantity: 5 }]);
  assert.equal((await buy(single, null, 1)).status, 201);
  assert.ok(lot("VIP"));
});

test("un lote agotado no se puede comprar y avisa cuántas quedan", async () => {
  const { event, lot } = await newEvent();
  const vip = lot("VIP");

  assert.equal((await buy(event, vip, 5)).status, 201);
  const soldOut = await buy(event, vip, 1);
  assert.equal(soldOut.status, 400);
  assert.match(soldOut.body.message, /VIP está agotado/);

  const early = lot("EARLY");
  assert.equal((await buy(event, early, 8)).status, 201);
  const short = await buy(event, early, 3);
  assert.equal(short.status, 400);
  assert.match(short.body.message, /Solo quedan 2 entradas disponibles en EARLY/);
});

test("editar nombre y precio de un lote no cambia las compras ya hechas", async () => {
  const { event, lot } = await newEvent();
  const vip = lot("VIP");
  const first = await buy(event, vip, 1);

  const edit = await call("PUT", `/api/events/${event.id}/lots/${vip.id}`, {
    token: ownerToken,
    body: { name: "VIP Plus", price: 8000 },
  });
  assert.equal(edit.status, 200);
  assert.equal(Number(edit.body.lot.price), 8000);

  const old = await Purchase.findByPk(first.body.purchase.id);
  assert.equal(old.lotName, "VIP");
  assert.equal(Number(old.totalPrice), 5000);

  const next = await buy(event, vip, 1);
  assert.equal(Number(next.body.purchase.totalPrice), 8000);
  assert.equal(next.body.purchase.lotName, "VIP Plus");
});

test("cambiar la cantidad asignada ajusta el cupo y no baja de lo vendido", async () => {
  const { event, lot } = await newEvent();
  const early = lot("EARLY");
  await buy(event, early, 4); // 4 vendidas o reservadas, quedan 6
  const url = `/api/events/${event.id}/lots/${early.id}`;

  // Subir: se suman las entradas nuevas al cupo
  const more = await call("PUT", url, { token: ownerToken, body: { quantity: 15 } });
  assert.equal(more.status, 200);
  assert.equal(more.body.lot.quantity, 15);
  assert.equal(more.body.lot.ticketsAvailable, 11);

  // Bajar hasta lo vendido: queda agotada
  const exact = await call("PUT", url, { token: ownerToken, body: { quantity: 4 } });
  assert.equal(exact.status, 200);
  assert.equal(exact.body.lot.ticketsAvailable, 0);
  assert.equal((await buy(event, early, 1)).status, 400);

  // Por debajo de lo vendido no se puede
  const below = await call("PUT", url, { token: ownerToken, body: { quantity: 3 } });
  assert.equal(below.status, 400);
  assert.match(below.body.message, /No se puede asignar menos de 4/);
  assert.equal((await Lot.findByPk(early.id)).quantity, 4);

  // Volver a subir la reabre
  const reopen = await call("PUT", url, { token: ownerToken, body: { quantity: 10 } });
  assert.equal(reopen.body.lot.ticketsAvailable, 6);
  assert.equal((await buy(event, early, 1)).status, 201);

  for (const quantity of [-1, 2.5, "10"]) {
    const bad = await call("PUT", url, { token: ownerToken, body: { quantity } });
    assert.equal(bad.status, 400, `quantity=${JSON.stringify(quantity)}`);
  }
});

test("agotar un lote lo deja en lo vendido y se puede reabrir", async () => {
  const { event, lot } = await newEvent();
  const general = lot("General");
  await buy(event, general, 7);
  const url = `/api/events/${event.id}/lots/${general.id}`;

  const res = await call("PUT", url, { token: ownerToken, body: { soldOut: true } });
  assert.equal(res.status, 200);
  assert.equal(res.body.lot.quantity, 7);
  assert.equal(res.body.lot.ticketsAvailable, 0);
  assert.equal((await buy(event, general, 1)).status, 400);

  // El comprador ve el lote con cupo 0 en el detalle del evento
  const detail = await call("GET", `/api/events/${event.id}`);
  assert.equal(detail.body.event.lots.find((l) => l.name === "General").ticketsAvailable, 0);
  assert.equal(detail.body.event.ticketsAvailable, 15); // EARLY 10 + VIP 5

  const reopen = await call("PUT", url, { token: ownerToken, body: { quantity: 12 } });
  assert.equal(reopen.body.lot.ticketsAvailable, 5);
});

test("se agregan lotes nuevos pero sin repetir nombres", async () => {
  const { event } = await newEvent();
  const url = `/api/events/${event.id}/lots`;

  const added = await call("POST", url, {
    token: ownerToken,
    body: { name: "Jugador", price: 500, quantity: 12 },
  });
  assert.equal(added.status, 201);
  assert.equal(added.body.lot.ticketsAvailable, 12);
  assert.equal(added.body.lot.position, 3); // va al final

  const repeated = await call("POST", url, {
    token: ownerToken,
    body: { name: "jugador", price: 1, quantity: 1 },
  });
  assert.equal(repeated.status, 400);

  const detail = await call("GET", `/api/events/${event.id}`);
  assert.equal(detail.body.event.lots.at(-1).name, "Jugador");
  assert.equal(detail.body.event.ticketsAvailable, 47);
});

test("solo se borran lotes sin ventas y nunca el último", async () => {
  const { event, lot } = await newEvent();
  await buy(event, lot("VIP"), 1);

  const sold = await call("DELETE", `/api/events/${event.id}/lots/${lot("VIP").id}`, {
    token: ownerToken,
  });
  assert.equal(sold.status, 400);
  assert.match(sold.body.message, /agotarlo/);

  assert.equal(
    (await call("DELETE", `/api/events/${event.id}/lots/${lot("EARLY").id}`, { token: ownerToken }))
      .status,
    200
  );
  assert.equal(
    (await call("DELETE", `/api/events/${event.id}/lots/${lot("General").id}`, { token: ownerToken }))
      .status,
    200
  );

  // Queda solo VIP, que tiene ventas
  const { event: single, lot: singleLot } = await newEvent([
    { name: "Única", price: 100, quantity: 5 },
  ]);
  const last = await call("DELETE", `/api/events/${single.id}/lots/${singleLot("Única").id}`, {
    token: ownerToken,
  });
  assert.equal(last.status, 400);
  assert.match(last.body.message, /al menos un lote/);
});

test("un lote de otro evento no se puede tocar desde este", async () => {
  const { event } = await newEvent();
  const { lot: otherLot } = await newEvent();

  const res = await call("PUT", `/api/events/${event.id}/lots/${otherLot("VIP").id}`, {
    token: ownerToken,
    body: { price: 1 },
  });
  assert.equal(res.status, 404);
  assert.equal(Number((await Lot.findByPk(otherLot("VIP").id)).price), 5000);
});

test("los eventos anteriores a los lotes se migran a un lote General", async () => {
  const owner = await User.findOne({ where: { email: "org@test.com" } });
  const legacy = await Event.create({
    title: "Viejo",
    description: "Anterior a los lotes",
    date: new Date(Date.now() + 86400000),
    location: "Salón",
    ticketPrice: 25000,
    ticketsAvailable: 297, // ya descontadas las 3 reservadas por la compra pendiente
    userId: owner.id,
  });
  const pending = await Purchase.create({
    eventId: legacy.id,
    buyerEmail: "a@test.com",
    buyerName: "A",
    quantity: 3,
    totalPrice: 75000,
    status: "pending",
  });

  assert.equal(await migrateEventsToLots(), 1);

  const lots = await Lot.findAll({ where: { eventId: legacy.id } });
  assert.equal(lots.length, 1);
  assert.equal(lots[0].name, "General");
  assert.equal(Number(lots[0].price), 25000);
  assert.equal(lots[0].quantity, 300); // 297 disponibles + 3 de la compra pendiente
  assert.equal(lots[0].ticketsAvailable, 297);

  const migrated = await Purchase.findByPk(pending.id);
  assert.equal(migrated.lotId, lots[0].id);
  assert.equal(migrated.lotName, "General");
  assert.equal(Number(migrated.unitPrice), 25000);

  // Idempotente: una segunda pasada no duplica nada
  assert.equal(await migrateEventsToLots(), 0);
  assert.equal(await Lot.count({ where: { eventId: legacy.id } }), 1);

  // Y el evento migrado se puede comprar sin indicar el lote
  const res = await call("POST", "/api/purchases/checkout", {
    body: { eventId: legacy.id, buyerName: "B", buyerEmail: "b@test.com", quantity: 1 },
  });
  assert.equal(res.status, 201);
  assert.equal(Number(res.body.purchase.totalPrice), 25000);
});
