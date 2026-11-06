// Evento "no listado": se vende pero no aparece en el listado público; se abre con su link
// (/e/<slug>). SQLite en memoria
process.env.DATABASE_URL = "sqlite::memory:";
process.env.JWT_SECRET = "test-secret";
process.env.NODE_ENV = "test";
process.env.RESEND_API_KEY = "";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");

const app = require("../server");
const { sequelize } = require("../config/database");
const User = require("../models/User");

let server;
let baseUrl;
let admin;

const sign = (user) => jwt.sign({ id: user.id, v: user.tokenVersion }, process.env.JWT_SECRET);
const call = async (method, path, { user, body } = {}) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(user ? { Authorization: `Bearer ${sign(user)}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

const create = (title, extra = {}) =>
  call("POST", "/api/events", {
    user: admin,
    body: {
      title,
      description: "x",
      date: new Date(Date.now() + 86400000).toISOString(),
      location: "Club",
      status: "published",
      lots: [{ name: "General", price: 1000, quantity: 10 }],
      ...extra,
    },
  });

const publicTitles = async () =>
  (await call("GET", "/api/events?limit=100")).body.events.map((e) => e.title);

before(async () => {
  await sequelize.sync({ force: true });
  admin = await User.create({ name: "Admin", email: "admin@test.com", password: "secret123", role: "admin" });
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  server.close();
  await sequelize.close();
});

test("un evento no listado no sale en el listado público pero se abre con su link", async () => {
  const listed = await create("Fiesta A");
  const hidden = await create("Fiesta B", { unlisted: true });
  assert.equal(listed.status, 201);
  assert.equal(hidden.status, 201);
  assert.equal(hidden.body.event.unlisted, true);

  // El listado público solo muestra el listado
  assert.deepEqual(await publicTitles(), ["Fiesta A"]);

  // Pero el link del no listado funciona, por slug y por id
  const bySlug = await call("GET", `/api/events/${hidden.body.event.slug}`);
  assert.equal(bySlug.status, 200);
  assert.equal(bySlug.body.event.title, "Fiesta B");
  assert.equal((await call("GET", `/api/events/${hidden.body.event.id}`)).status, 200);

  // El administrador los ve todos
  const adminList = await call("GET", "/api/events?limit=100", { user: admin });
  assert.deepEqual(adminList.body.events.map((e) => e.title).sort(), ["Fiesta A", "Fiesta B"]);
});

test("se puede pasar un evento a no listado y volver, con registro del cambio", async () => {
  const ev = (await create("Fiesta C")).body.event;
  assert.ok((await publicTitles()).includes("Fiesta C"));

  const hide = await call("PUT", `/api/events/${ev.id}`, { user: admin, body: { unlisted: true } });
  assert.equal(hide.status, 200);
  assert.equal(hide.body.event.unlisted, true);
  assert.ok(!(await publicTitles()).includes("Fiesta C"));

  const show = await call("PUT", `/api/events/${ev.id}`, { user: admin, body: { unlisted: false } });
  assert.equal(show.body.event.unlisted, false);
  assert.ok((await publicTitles()).includes("Fiesta C"));
});

test("un no listado en borrador sigue sin verse, y editar otra cosa no cambia el flag", async () => {
  const ev = (await create("Fiesta D", { unlisted: true, status: "draft" })).body.event;
  assert.equal((await call("GET", `/api/events/${ev.slug}`)).status, 404);

  await call("PUT", `/api/events/${ev.id}`, { user: admin, body: { title: "Fiesta D bis" } });
  const after = await call("GET", `/api/events/${ev.id}`, { user: admin });
  assert.equal(after.body.event.unlisted, true);
});

test("el valor de no listado tiene que ser verdadero o falso", async () => {
  const bad = await create("Fiesta E", { unlisted: "si" });
  assert.equal(bad.status, 400);
  const ev = (await create("Fiesta F")).body.event;
  const badEdit = await call("PUT", `/api/events/${ev.id}`, { user: admin, body: { unlisted: "si" } });
  assert.equal(badEdit.status, 400);
});

test("un evento nuevo sin indicar nada es listado", async () => {
  const ev = (await create("Fiesta G")).body.event;
  assert.equal(ev.unlisted, false);
  assert.ok((await publicTitles()).includes("Fiesta G"));
});
