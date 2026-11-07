// QA: casos límite de cortesías y mapQuery (complementa courtesies.test.js y map.test.js)
process.env.DATABASE_URL = "sqlite::memory:";
process.env.JWT_SECRET = "test-secret";
process.env.NODE_ENV = "test";
process.env.RESEND_API_KEY = "re_test_key";
process.env.RESEND_FROM = "Tickets <tickets@test.com>";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  if (String(url).includes("api.resend.com")) {
    return new Response(JSON.stringify({ id: "e1" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return realFetch(url, options);
};

const app = require("../server");
const { sequelize } = require("../config/database");
const User = require("../models/User");
const Event = require("../models/Event");
const Purchase = require("../models/Purchase");

let server, baseUrl, admin, event, other;
const sign = (u) => jwt.sign({ id: u.id, v: u.tokenVersion }, process.env.JWT_SECRET);
const asAdmin = async (method, path, body) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${sign(admin)}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

before(async () => {
  await sequelize.sync({ force: true });
  admin = await User.create({ name: "Admin", email: "admin@test.com", password: "secret123", role: "admin" });
  const base = { description: "x", date: new Date(Date.now() + 86400000), location: "Club", userId: admin.id };
  event = await Event.create({ ...base, title: "A" });
  other = await Event.create({ ...base, title: "B" });
  await new Promise((r) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
});
after(async () => { globalThis.fetch = realFetch; server.close(); await sequelize.close(); });

test("cantidad por defecto 1, límites 1 y 20, nombre/email normalizados", async () => {
  const r = await asAdmin("POST", `/api/courtesies/event/${event.id}`, { name: "  Ana  ", email: "ANA@Test.com " });
  assert.equal(r.status, 201);
  assert.equal(r.body.courtesy.quantity, 1);
  assert.equal(r.body.courtesy.buyerName, "Ana");
  assert.equal(r.body.courtesy.buyerEmail, "ana@test.com");
  const r20 = await asAdmin("POST", `/api/courtesies/event/${event.id}`, { name: "B", email: "b@test.com", quantity: 20 });
  assert.equal(r20.status, 201);
  assert.equal(r20.body.courtesy.Tickets.length, 20);
  assert.equal(new Set(r20.body.courtesy.Tickets.map((t) => t.code)).size, 20);
});

test("tipos raros en nombre/email/cuerpo vacío dan 400, no 500", async () => {
  for (const body of [{ name: 123, email: "a@b.com" }, { name: "A", email: ["a@b.com"] }, { name: "   ", email: "a@b.com" }, {}, { name: "A", email: "a@b.com", quantity: null }]) {
    const r = await asAdmin("POST", `/api/courtesies/event/${event.id}`, body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
});

test("una cortesía no se toca desde la ruta de otro evento ni con id inválido", async () => {
  const c = (await asAdmin("POST", `/api/courtesies/event/${event.id}`, { name: "C", email: "c@test.com" })).body.courtesy;
  for (const [m, suffix, body] of [["PUT", "", { name: "X" }], ["POST", "/send"], ["POST", "/void"]]) {
    const r = await asAdmin(m, `/api/courtesies/event/${other.id}/${c.id}${suffix}`, body);
    assert.equal(r.status, 404, `${m}${suffix}`);
  }
  const bad = await asAdmin("PUT", `/api/courtesies/event/${event.id}/no-es-uuid`, { name: "X" });
  assert.ok([400, 404].includes(bad.status), `id inválido dio ${bad.status}`);
  const list = await asAdmin("GET", `/api/courtesies/event/${other.id}`);
  assert.equal(list.body.courtesies.length, 0);
});

test("compras reales no aparecen como cortesías ni se pueden anular por esa ruta", async () => {
  const p = await Purchase.create({ eventId: event.id, buyerName: "Real", buyerEmail: "r@test.com", quantity: 1, totalPrice: 100, status: "completed" });
  const list = await asAdmin("GET", `/api/courtesies/event/${event.id}`);
  assert.ok(!list.body.courtesies.some((x) => x.id === p.id));
  assert.equal((await asAdmin("POST", `/api/courtesies/event/${event.id}/${p.id}/void`)).status, 404);
  assert.equal((await asAdmin("PUT", `/api/courtesies/event/${event.id}/${p.id}`, { name: "Hack" })).status, 404);
  await p.reload();
  assert.equal(p.status, "completed");
  assert.equal(p.buyerName, "Real");
});

test("anular dos veces da 409; enviar o editar una anulada: send 400", async () => {
  const c = (await asAdmin("POST", `/api/courtesies/event/${event.id}`, { name: "D", email: "d@test.com", quantity: 2 })).body.courtesy;
  const path = `/api/courtesies/event/${event.id}/${c.id}`;
  assert.equal((await asAdmin("POST", `${path}/void`)).status, 200);
  assert.equal((await asAdmin("POST", `${path}/void`)).status, 409);
  assert.equal((await asAdmin("POST", `${path}/send`)).status, 400);
  assert.equal((await asAdmin("PUT", path, {})).status, 400);
});

test("mapQuery: 200 caracteres ok, 201 rechazado, tipos no string rechazados, espacios = sin valor", async () => {
  const mk = (extra) => asAdmin("PUT", `/api/events/${event.id}`, extra);
  assert.equal((await mk({ mapQuery: "x".repeat(200) })).status, 200);
  assert.equal((await mk({ mapQuery: "x".repeat(201) })).status, 400);
  for (const v of [123, true, {}, ["a"]]) assert.equal((await mk({ mapQuery: v })).status, 400, JSON.stringify(v));
  assert.equal((await mk({ mapQuery: "   " })).status, 200);
  await event.reload();
  assert.equal(event.mapQuery, null);
});
