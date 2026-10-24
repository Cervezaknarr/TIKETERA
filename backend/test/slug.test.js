// Cada evento tiene su URL pública /e/<slug>, con SQLite en memoria
process.env.DATABASE_URL = "sqlite::memory:";
process.env.JWT_SECRET = "test-secret";
process.env.NODE_ENV = "test";
process.env.RESEND_API_KEY = "";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const app = require("../server");
const { sequelize } = require("../config/database");
const User = require("../models/User");
const Event = require("../models/Event");
const { slugify, backfillSlugs } = require("../utils/slug");

let server;
let baseUrl;
let owner;

const make = (title) =>
  Event.create({
    title,
    description: "x",
    date: new Date(Date.now() + 86400000),
    location: "Club",
    userId: owner.id,
  });

before(async () => {
  await sequelize.sync({ force: true });
  owner = await User.create({ name: "Org", email: "o@test.com", password: "secreto123", role: "admin" });
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

test("slugify saca tildes y símbolos", () => {
  assert.equal(slugify("Fiesta de Verano 2026!"), "fiesta-de-verano-2026");
  assert.equal(slugify("¡Ñandú Año!"), "nandu-ano");
  assert.equal(slugify("!!!"), "evento");
});

test("el evento recibe un slug único y se consulta por él", async () => {
  const a = await make("Fiesta Verano");
  const b = await make("Fiesta Verano");
  assert.equal(a.slug, "fiesta-verano");
  assert.equal(b.slug, "fiesta-verano-2");

  const res = await fetch(`${baseUrl}/api/events/${a.slug}`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).event.id, a.id);

  assert.equal((await fetch(`${baseUrl}/api/events/${a.id}`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/events/no-existe`)).status, 404);
});

test("/e/<slug> sirve el sitio de visitantes", async () => {
  const res = await fetch(`${baseUrl}/e/fiesta-verano`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Ticketera/);
});

test("los eventos viejos sin slug lo reciben al arrancar", async () => {
  const old = await make("Evento Viejo");
  await Event.update({ slug: null }, { where: { id: old.id } });
  assert.equal(await backfillSlugs(Event), 1);
  assert.equal((await Event.findByPk(old.id)).slug, "evento-viejo");
});

test("la portada acepta imágenes subidas y rechaza lo demás", async () => {
  const token = require("jsonwebtoken").sign({ id: owner.id }, "test-secret");
  const create = (imageUrl) =>
    fetch(`${baseUrl}/api/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        title: "Con portada",
        description: "x",
        date: new Date(Date.now() + 86400000).toISOString(),
        location: "Club",
        imageUrl,
        lots: [{ name: "General", price: 100, quantity: 10 }],
      }),
    });

  const ok = await create("data:image/jpeg;base64,/9j/4AAQSkZJRg==");
  assert.equal(ok.status, 201);
  assert.match((await ok.json()).event.imageUrl, /^data:image\/jpeg/);
  assert.equal((await create("data:text/html;base64,PGI+")).status, 400);
  assert.equal((await create("javascript:alert(1)")).status, 400);
});
