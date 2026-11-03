// Tests de cabeceras de seguridad y sesiones, con SQLite en memoria
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

let server;
let baseUrl;
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
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
};

const login = async (email, password) =>
  (await call("POST", "/api/auth/login", { body: { email, password } })).body.token;

let staffCount = 0;
const newStaff = async () => {
  const email = `staff${++staffCount}@test.com`;
  const user = await User.create({ name: "Puerta", email, password: "password-1", role: "staff" });
  return { user, email, token: await login(email, "password-1") };
};

before(async () => {
  await sequelize.sync({ force: true });
  await User.create({ name: "Admin", email: "admin@test.com", password: "password-1", role: "admin" });
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  adminToken = await login("admin@test.com", "password-1");
});

after(async () => {
  server.close();
  await sequelize.close();
});

test("las páginas y la API mandan las cabeceras de seguridad", async () => {
  for (const path of ["/", "/admin/", "/staff/", "/api/events"]) {
    const res = await fetch(`${baseUrl}${path}`);
    const csp = res.headers.get("content-security-policy");
    assert.match(csp, /frame-ancestors 'none'/, path);
    assert.match(csp, /connect-src 'self'/, path);
    assert.match(csp, /object-src 'none'/, path);
    assert.match(csp, /frame-src https:\/\/www\.google\.com/, path);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff", path);
    assert.equal(res.headers.get("x-powered-by"), null, path);
    await res.text();
  }
});

test("el token dura 3 días por defecto y JWT_EXPIRES_IN lo cambia", async () => {
  const days = (token) => {
    const { iat, exp } = jwt.decode(token);
    return (exp - iat) / 86400;
  };
  assert.equal(days(adminToken), 3);

  process.env.JWT_EXPIRES_IN = "1d";
  try {
    assert.equal(days(await login("admin@test.com", "password-1")), 1);
  } finally {
    delete process.env.JWT_EXPIRES_IN;
  }
});

test("cambiar la contraseña corta las sesiones abiertas; la contraseña nueva entra", async () => {
  const { user, email, token } = await newStaff();
  assert.equal((await call("GET", "/api/auth/profile", { token })).status, 200);

  const res = await call("PUT", `/api/users/${user.id}`, {
    token: adminToken,
    body: { password: "password-2" },
  });
  assert.equal(res.status, 200);

  assert.equal((await call("GET", "/api/auth/profile", { token })).status, 401);
  assert.equal(await login(email, "password-1"), undefined);
  const fresh = await login(email, "password-2");
  assert.equal((await call("GET", "/api/auth/profile", { token: fresh })).status, 200);
});

test("cambiar solo el nombre no corta la sesión", async () => {
  const { user, token } = await newStaff();
  await call("PUT", `/api/users/${user.id}`, { token: adminToken, body: { name: "Puerta 2" } });
  assert.equal((await call("GET", "/api/auth/profile", { token })).status, 200);
});

test("un token anterior a este cambio sigue valiendo hasta que cambie la contraseña", async () => {
  const { user } = await newStaff();
  const old = jwt.sign({ id: user.id }, process.env.JWT_SECRET);
  assert.equal((await call("GET", "/api/auth/profile", { token: old })).status, 200);

  await call("PUT", `/api/users/${user.id}`, { token: adminToken, body: { password: "password-2" } });
  assert.equal((await call("GET", "/api/auth/profile", { token: old })).status, 401);
});

test("un admin con la sesión cortada ya no ve lo que solo ve el admin", async () => {
  const admin = await User.create({ name: "A2", email: "a2@test.com", password: "password-1", role: "admin" });
  const token = await login("a2@test.com", "password-1");
  admin.password = "password-2";
  await admin.save();
  assert.equal((await call("POST", "/api/events", { token, body: {} })).status, 401);

  const { optionalAdmin } = require("../middleware/authMiddleware");
  const req = { headers: { authorization: `Bearer ${token}` } };
  await optionalAdmin(req, {}, () => {});
  assert.equal(req.isAdmin, false);
});
