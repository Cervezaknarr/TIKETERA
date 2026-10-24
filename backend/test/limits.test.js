// Tests de topes contra acaparamiento, límite por IP y ventana de pago
process.env.DATABASE_URL = "sqlite::memory:";
process.env.JWT_SECRET = "test-secret";
process.env.NODE_ENV = "test";
process.env.RESEND_API_KEY = ""; // Email inactivo

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const app = require("../server");
const { sequelize } = require("../config/database");
const User = require("../models/User");
const Event = require("../models/Event");
const Lot = require("../models/Lot");
const Purchase = require("../models/Purchase");
const { createRateLimiter } = require("../middleware/rateLimit");
const { paymentWindowMinutes, holdMinutes } = require("../utils/paymentWindow");
const { releaseExpiredPurchases } = require("../utils/purchases");

let server;
let baseUrl;
let owner;

const post = async (path, body) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const newEvent = async (quantity = 100) => {
  const event = await Event.create({
    title: "Evento",
    description: "Prueba",
    date: new Date(Date.now() + 86400000),
    location: "Salón",
    userId: owner.id,
  });
  event.lot = await Lot.create({
    eventId: event.id,
    name: "General",
    price: 1000,
    quantity,
    ticketsAvailable: quantity,
  });
  return event;
};

const buy = (event, quantity, email = "comprador@test.com") =>
  post("/api/purchases/checkout", {
    eventId: event.id,
    lotId: event.lot.id,
    buyerName: "Comprador",
    buyerEmail: email,
    quantity,
  });

const available = async (event) => (await Lot.findByPk(event.lot.id)).ticketsAvailable;

before(async () => {
  await sequelize.sync({ force: true });
  owner = await User.create({ name: "Org", email: "org@test.com", password: "secret" });
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await sequelize.close();
});

test("una compra no puede superar el máximo de entradas y no toca el cupo", async () => {
  const event = await newEvent(100);

  const tooMany = await buy(event, 11);
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.message, /hasta 10 entradas por compra/);
  assert.equal(await available(event), 100);

  assert.equal((await buy(event, 10)).status, 201);
  assert.equal(await available(event), 90);
});

test("el máximo por compra se puede cambiar con una variable de entorno", async () => {
  const event = await newEvent(100);
  process.env.MAX_TICKETS_PER_PURCHASE = "2";
  try {
    assert.equal((await buy(event, 3)).status, 400);
    assert.equal((await buy(event, 2)).status, 201);
  } finally {
    delete process.env.MAX_TICKETS_PER_PURCHASE;
  }
});

test("un mismo email no acumula compras sin pagar, sin importar mayúsculas", async () => {
  const event = await newEvent(100);
  process.env.MAX_PENDING_PER_EMAIL = "2";
  try {
    assert.equal((await buy(event, 1, "Ana@Test.com")).status, 201);
    assert.equal((await buy(event, 1, "ana@test.com")).status, 201);

    const blocked = await buy(event, 1, "ANA@test.COM");
    assert.equal(blocked.status, 429);
    assert.match(blocked.body.message, /sin terminar de pagar/);
    assert.equal(await available(event), 98);

    // Otro email sí puede comprar, y el tope es por evento
    assert.equal((await buy(event, 1, "otra@test.com")).status, 201);
    const other = await newEvent(100);
    assert.equal((await buy(other, 1, "ana@test.com")).status, 201);
  } finally {
    delete process.env.MAX_PENDING_PER_EMAIL;
  }
});

test("al pagar o vencer una compra, el email puede volver a comprar", async () => {
  const event = await newEvent(100);
  process.env.MAX_PENDING_PER_EMAIL = "1";
  try {
    const first = await buy(event, 1, "pago@test.com");
    assert.equal((await buy(event, 1, "pago@test.com")).status, 429);

    // Se paga: ya no cuenta como pendiente
    await post("/api/purchases/webhook", {
      paymentGatewayId: first.body.purchase.paymentGatewayId,
      status: "approved",
    });
    const second = await buy(event, 1, "pago@test.com");
    assert.equal(second.status, 201);

    // Vence sin pagar: tampoco cuenta
    await Purchase.update(
      { createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      { where: { id: second.body.purchase.id }, silent: true }
    );
    await releaseExpiredPurchases();
    assert.equal((await buy(event, 1, "pago@test.com")).status, 201);
  } finally {
    delete process.env.MAX_PENDING_PER_EMAIL;
  }
});

test("el limitador por IP corta pasado el máximo y avisa", async () => {
  const limited = express();
  limited.use(
    createRateLimiter({ windowMs: 60 * 1000, max: 3, message: "Demasiados intentos" })
  );
  limited.post("/x", (req, res) => res.json({ ok: true }));
  const srv = limited.listen(0);
  try {
    const url = `http://127.0.0.1:${srv.address().port}/x`;
    const statuses = [];
    let last;
    for (let i = 0; i < 5; i++) {
      last = await fetch(url, { method: "POST" });
      statuses.push(last.status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
    assert.deepEqual(await last.json(), { success: false, message: "Demasiados intentos" });
  } finally {
    srv.close();
  }
});

test("con el máximo en 0 el limitador no limita", async () => {
  const open = express();
  open.use(createRateLimiter({ windowMs: 60 * 1000, max: 0, message: "no" }));
  open.post("/x", (req, res) => res.json({ ok: true }));
  const srv = open.listen(0);
  try {
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`http://127.0.0.1:${srv.address().port}/x`, { method: "POST" });
      assert.equal(res.status, 200);
    }
  } finally {
    srv.close();
  }
});

test("la retención del cupo sigue a la ventana de pago", async () => {
  assert.equal(paymentWindowMinutes(), 15);
  assert.equal(holdMinutes(), 20);

  process.env.PAYMENT_WINDOW_MINUTES = "10";
  try {
    assert.equal(paymentWindowMinutes(), 10);
    assert.equal(holdMinutes(), 15);

    process.env.PURCHASE_HOLD_MINUTES = "30";
    assert.equal(holdMinutes(), 30); // el valor explícito manda
  } finally {
    delete process.env.PAYMENT_WINDOW_MINUTES;
    delete process.env.PURCHASE_HOLD_MINUTES;
  }
});

test("una compra pendiente se libera pasada la retención nueva y no antes", async () => {
  const event = await newEvent(10);
  const { purchase } = (await buy(event, 3, "retencion@test.com")).body;
  assert.equal(await available(event), 7);

  // A los 10 minutos sigue reservada (la retención es de 20)
  await Purchase.update(
    { createdAt: new Date(Date.now() - 10 * 60 * 1000) },
    { where: { id: purchase.id }, silent: true }
  );
  assert.equal(await releaseExpiredPurchases(), 0);
  assert.equal(await available(event), 7);

  // A los 25 minutos se libera
  await Purchase.update(
    { createdAt: new Date(Date.now() - 25 * 60 * 1000) },
    { where: { id: purchase.id }, silent: true }
  );
  assert.equal(await releaseExpiredPurchases(), 1);
  assert.equal(await available(event), 10);
});
