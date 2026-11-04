// Los sitios del personal viven en /adminGt, /organizadorGt y /staffGt; los nombres comunes no existen
process.env.DATABASE_URL = "sqlite::memory:";
process.env.JWT_SECRET = "test-secret";
process.env.NODE_ENV = "test";
process.env.RESEND_API_KEY = "";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const app = require("../server");
const { sequelize } = require("../config/database");

let server;
let baseUrl;
const get = (p) => fetch(`${baseUrl}${p}`, { redirect: "manual" });

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

test("los sitios del personal responden en su dirección con sufijo", async () => {
  for (const p of ["/adminGt/", "/organizadorGt/", "/staffGt/"]) {
    assert.equal((await get(p)).status, 200, p);
  }
});

test("las direcciones comunes no existen", async () => {
  for (const p of ["/admin/", "/admin/index.html", "/organizador/", "/staff/", "/staff/index.html"]) {
    assert.equal((await get(p)).status, 404, p);
  }
});

test("el panel enlaza al escáner con la dirección nueva", async () => {
  const html = await (await get("/adminGt/")).text();
  assert.ok(html.includes('href="/staffGt/"'));
  assert.ok(!html.includes('href="/staff/"'));
});

test("los sitios del personal piden no ser indexados y no hay robots.txt que los liste", async () => {
  for (const p of ["/adminGt/", "/organizadorGt/", "/staffGt/"]) {
    assert.match((await get(p)).headers.get("x-robots-tag") || "", /noindex/, p);
  }
  assert.equal((await get("/robots.txt")).status, 404);
  assert.equal(((await get("/")).headers.get("x-robots-tag")), null);
});
