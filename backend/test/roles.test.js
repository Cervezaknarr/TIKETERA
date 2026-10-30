// Tests de roles: visitantes sin cuenta, staff solo escanea, admin administra
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
const { ensureAdmin } = require("../utils/admin");

let server;
let baseUrl;
let adminToken;
let staffToken;
let userToken;

const api = async (method, path, { token, body } = {}) => {
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

const newEvent = {
  title: "Fiesta",
  description: "Evento de prueba",
  date: new Date(Date.now() + 86400000).toISOString(),
  location: "Salón",
  status: "published",
  ticketPrice: 1000,
  ticketsAvailable: 100,
};

before(async () => {
  await sequelize.sync({ force: true });

  const adminUser = await User.create({
    name: "Admin",
    email: "admin@test.com",
    password: "secret123",
    role: "admin",
  });
  const staffUser = await User.create({
    name: "Puerta",
    email: "puerta@test.com",
    password: "secret123",
    role: "staff",
  });
  // Cuenta "user" que quedó del registro anterior
  const oldUser = await User.create({
    name: "Viejo",
    email: "viejo@test.com",
    password: "secret123",
  });

  adminToken = jwt.sign({ id: adminUser.id }, process.env.JWT_SECRET);
  staffToken = jwt.sign({ id: staffUser.id }, process.env.JWT_SECRET);
  userToken = jwt.sign({ id: oldUser.id }, process.env.JWT_SECRET);

  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await sequelize.close();
});

test("no hay registro público", async () => {
  const res = await api("POST", "/api/auth/register", {
    body: { name: "X", email: "x@test.com", password: "secret123" },
  });
  assert.equal(res.status, 404);
});

test("solo staff y admin pueden iniciar sesión", async () => {
  const staff = await api("POST", "/api/auth/login", {
    body: { email: "puerta@test.com", password: "secret123" },
  });
  assert.equal(staff.status, 200);
  assert.equal(staff.body.user.role, "staff");

  const old = await api("POST", "/api/auth/login", {
    body: { email: "viejo@test.com", password: "secret123" },
  });
  assert.equal(old.status, 403);
  assert.equal(old.body.token, undefined);

  const wrong = await api("POST", "/api/auth/login", {
    body: { email: "puerta@test.com", password: "otra-cosa" },
  });
  assert.equal(wrong.status, 401);
});

test("solo el admin crea, modifica y borra eventos", async () => {
  for (const token of [staffToken, userToken]) {
    const res = await api("POST", "/api/events", { token, body: newEvent });
    assert.equal(res.status, 403);
  }
  const anon = await api("POST", "/api/events", { body: newEvent });
  assert.equal(anon.status, 401);

  const created = await api("POST", "/api/events", {
    token: adminToken,
    body: newEvent,
  });
  assert.equal(created.status, 201);
  const { id } = created.body.event;

  const staffEdit = await api("PUT", `/api/events/${id}`, {
    token: staffToken,
    body: { title: "Otro" },
  });
  assert.equal(staffEdit.status, 403);

  const edit = await api("PUT", `/api/events/${id}`, {
    token: adminToken,
    body: { title: "Fiesta 2" },
  });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.event.title, "Fiesta 2");

  const staffDelete = await api("DELETE", `/api/events/${id}`, {
    token: staffToken,
  });
  assert.equal(staffDelete.status, 403);

  // Los visitantes siguen viendo los eventos sin cuenta
  const list = await api("GET", "/api/events");
  assert.equal(list.status, 200);
  assert.equal(list.body.events.length, 1);
});

test("no se venden entradas de eventos cancelados", async () => {
  const { body } = await api("GET", "/api/events");
  const { id } = body.events[0];
  await api("PUT", `/api/events/${id}`, {
    token: adminToken,
    body: { status: "cancelled" },
  });
  const res = await api("POST", "/api/purchases/checkout", {
    body: { eventId: id, buyerName: "Ana", buyerEmail: "ana@test.com", quantity: 1 },
  });
  assert.equal(res.status, 400);
  await api("PUT", `/api/events/${id}`, {
    token: adminToken,
    body: { status: "published" },
  });
});

test("el staff puede escanear", async () => {
  const { body } = await api("GET", "/api/events");
  const res = await api(
    "POST",
    `/api/checkin/events/${body.events[0].id}/sync`,
    { token: staffToken, body: { deviceId: "puerta", scans: [] } }
  );
  assert.equal(res.status, 200);
});

test("solo el admin gestiona usuarios", async () => {
  for (const token of [staffToken, userToken, undefined]) {
    const res = await api("GET", "/api/users", { token });
    assert.equal(res.status, token ? 403 : 401);
  }

  const list = await api("GET", "/api/users", { token: adminToken });
  assert.equal(list.status, 200);
  // Las cuentas "user" no son personal y no aparecen
  assert.deepEqual(list.body.users.map((u) => u.email).sort(), [
    "admin@test.com",
    "puerta@test.com",
  ]);
  assert.ok(list.body.users.every((u) => u.password === undefined));
});

test("el admin crea staff, le cambia la contraseña y lo borra", async () => {
  const created = await api("POST", "/api/users", {
    token: adminToken,
    // Aunque mande role admin, siempre se crea como staff
    body: { name: "Puerta 2", email: " Puerta2@Test.com ", password: "clave1234", role: "admin" },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.user.role, "staff");
  assert.equal(created.body.user.email, "puerta2@test.com");
  const { id } = created.body.user;

  const dup = await api("POST", "/api/users", {
    token: adminToken,
    body: { name: "X", email: "puerta2@test.com", password: "clave1234" },
  });
  assert.equal(dup.status, 400);

  const short = await api("POST", "/api/users", {
    token: adminToken,
    body: { name: "X", email: "x@test.com", password: "123" },
  });
  assert.equal(short.status, 400);

  const login = () =>
    api("POST", "/api/auth/login", {
      body: { email: "puerta2@test.com", password: "nueva-clave" },
    });
  assert.equal((await login()).status, 401);
  const updated = await api("PUT", `/api/users/${id}`, {
    token: adminToken,
    body: { password: "nueva-clave" },
  });
  assert.equal(updated.status, 200);
  const ok = await login();
  assert.equal(ok.status, 200);

  const removed = await api("DELETE", `/api/users/${id}`, { token: adminToken });
  assert.equal(removed.status, 200);
  // La sesión del staff borrado deja de funcionar
  const after = await api("GET", "/api/auth/profile", { token: ok.body.token });
  assert.equal(after.status, 401);
});

test("los admin no se pueden modificar ni borrar desde la API", async () => {
  const admin = await User.findOne({ where: { email: "admin@test.com" } });
  const edit = await api("PUT", `/api/users/${admin.id}`, {
    token: adminToken,
    body: { password: "otra-clave-123" },
  });
  assert.equal(edit.status, 404);
  const del = await api("DELETE", `/api/users/${admin.id}`, { token: adminToken });
  assert.equal(del.status, 404);
});

test("ensureAdmin crea el admin inicial o asciende uno existente", async () => {
  process.env.ADMIN_EMAIL = "Jefe@Test.com";
  process.env.ADMIN_PASSWORD = "corta";
  await ensureAdmin();
  assert.equal(await User.count({ where: { email: "jefe@test.com" } }), 0);

  process.env.ADMIN_PASSWORD = "clave-larga-123";
  await ensureAdmin();
  const jefe = await User.findOne({ where: { email: "jefe@test.com" } });
  assert.equal(jefe.role, "admin");
  assert.ok(await jefe.comparePassword("clave-larga-123"));

  // Si ya existe no cambia la contraseña
  process.env.ADMIN_PASSWORD = "otra-clave-456";
  await ensureAdmin();
  await jefe.reload();
  assert.ok(await jefe.comparePassword("clave-larga-123"));

  // Asciende una cuenta existente
  process.env.ADMIN_EMAIL = "viejo@test.com";
  await ensureAdmin();
  assert.equal((await User.findOne({ where: { email: "viejo@test.com" } })).role, "admin");

  delete process.env.ADMIN_EMAIL;
  delete process.env.ADMIN_PASSWORD;
});
