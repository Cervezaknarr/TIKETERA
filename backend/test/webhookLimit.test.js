// Límite de pedidos por IP al webhook y al link privado de la compra (hallazgo P3 / T2.13)
process.env.DATABASE_URL = "sqlite::memory:";
process.env.JWT_SECRET = "test-secret";
process.env.NODE_ENV = "test";
process.env.RESEND_API_KEY = "";
process.env.RATE_LIMIT_WEBHOOK_MAX = "3";
process.env.RATE_LIMIT_TICKETS_MAX = "3";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const app = require("../server");
const { sequelize } = require("../config/database");

let server;
let baseUrl;

before(async () => {
  await sequelize.sync({ force: true });
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await sequelize.close();
});

const statuses = async (method, path, n) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: method === "POST" ? JSON.stringify({}) : undefined,
    });
    out.push(res.status);
  }
  return out;
};

test("el webhook responde 429 al superar el límite por IP", async () => {
  const s = await statuses("POST", "/api/purchases/webhook", 5);
  assert.deepEqual(s.slice(3), [429, 429]);
  assert.ok(s.slice(0, 3).every((c) => c !== 429));
});

test("el link privado de la compra responde 429 al superar el límite", async () => {
  const s = await statuses("GET", "/api/purchases/tickets/token-inexistente", 5);
  assert.deepEqual(s.slice(0, 3), [404, 404, 404]);
  assert.deepEqual(s.slice(3), [429, 429]);
});
