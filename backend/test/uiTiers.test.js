// Tandas bloqueadas en la página pública (DOM simulado con node:vm, sin navegador).
// NO prueba layout/CSS ni el aspecto en gris: solo el HTML generado y la lógica.
process.env.DATABASE_URL = "sqlite::memory:";
process.env.JWT_SECRET = "test-secret";
process.env.NODE_ENV = "test";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const FRONT = path.join(__dirname, "..", "..", "frontend");
const read = (f) => fs.readFileSync(path.join(FRONT, f), "utf8");

class El {
  constructor(id) { this.id = id; this.innerHTML = ""; this.textContent = ""; this.value = ""; this.src = ""; this.dataset = {}; this.disabled = false; this.style = {}; this.classList = { add() {}, remove() {}, toggle() {} }; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  appendChild(c) { return c; }
  remove() {}
  focus() {}
  setAttribute() {}
  addEventListener() {}
}
function makeEnv(routes) {
  const els = new Map();
  const calls = [];
  const replaced = [];
  const get = (id) => { if (!els.has(id)) els.set(id, new El(id)); return els.get(id); };
  const ctx = {
    document: { body: new El("body"), getElementById: get, querySelectorAll: () => [], createElement: () => new El() },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { origin: "http://localhost", hash: "", pathname: "/e/fiesta", search: "" },
    addEventListener() {},
    history: { pushState() {}, replaceState(_s, _t, url) { replaced.push([url]); } },
    navigator: {},
    setTimeout, clearTimeout, setInterval, clearInterval, console, URL, encodeURIComponent, Intl, Date,
    fetch: async (url, opts = {}) => {
      const u = String(url).replace("http://localhost/api", "");
      const method = opts.method || "GET";
      calls.push({ method, url: u });
      const key = Object.keys(routes).find((k) => `${method} ${u}`.startsWith(k));
      const out = key ? routes[key] : { status: 404, body: { success: false, message: "sin ruta " + u } };
      const { status = 200, body } = typeof out === "function" ? out() : out;
      return { ok: status < 400, status, json: async () => body };
    },
  };
  ctx.window = ctx;
  ctx.window.scrollTo = () => {};
  vm.createContext(ctx);
  const run = (code, name) => vm.runInContext(code, ctx, { filename: name });
  run(read("common.js"), "common.js");
  const html = read("index.html");
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) run(m[1], "index.html");
  return { run, get, calls, replaced };
}
const flush = () => new Promise((r) => setTimeout(r, 30));

const lot = (o) => ({ id: "l1", name: "General 1", price: 10000, ticketsAvailable: 5, ...o });
const event = (lots, packs = []) => ({ id: "e1", title: "Fiesta", location: "Club", description: "d", date: "2030-01-01T20:00:00Z", slug: "fiesta", salesPaused: false, lots, packs });
const evRoutes = (ev) => ({ "GET /events/fiesta": { body: { success: true, event: ev } }, "GET /purchases/status": { body: { salesPaused: false } } });

test("tanda bloqueada: sin selector, con etiqueta, nombre y precio, sin cupo, escapada", async () => {
  const ev = event([
    lot({ id: "l1", name: "General 1", ticketsAvailable: 5 }),
    lot({ id: "l2", name: "General <i>2</i>", price: 13000, ticketsAvailable: 77, locked: true }),
  ], [{ id: "p2", lotId: "l2", quantity: 2, discountPercent: 10 }, { id: "p1", lotId: "l1", quantity: 2, discountPercent: 10 }]);
  const env = makeEnv(evRoutes(ev));
  await flush();
  await env.run("viewBuy('fiesta')");
  const html = env.get("view").innerHTML;
  const cards = html.split('<div class="ev-lot').slice(1);
  const normal = cards.find((c) => c.includes("General 1</span>") && !c.includes("ev-pack"));
  const locked = cards.find((c) => c.includes("locked") && !c.includes("ev-pack"));
  const lockedPack = cards.find((c) => c.includes("ev-pack locked"));
  const normalPack = cards.find((c) => c.includes("ev-pack") && !c.includes("locked"));
  // lote normal intacto
  assert.match(normal, /data-lot="l1"/);
  assert.match(normal, /stepQty\('l1', 1\)/);
  // tanda bloqueada
  assert.doesNotMatch(locked, /ev-stepper|data-lot|stepQty|<button|Cantidad/);
  assert.match(locked, /Próximamente/);
  assert.doesNotMatch(locked, /Se habilita al agotarse/);
  assert.match(locked, /\$13\.000/);
  assert.match(locked, /General &lt;i&gt;2&lt;\/i&gt;/);
  assert.doesNotMatch(locked, /<i>2/);
  assert.doesNotMatch(locked, /77/);
  // packs
  assert.doesNotMatch(lockedPack, /ev-stepper|data-pack|stepPack|<button/);
  assert.match(lockedPack, /Próximamente/);
  assert.match(normalPack, /data-pack="p1"/);
  assert.doesNotMatch(html, /data-pack="p2"|stepQty\('l2'/);
});

test("lotBuyable: bloqueado, agotado y locked ausente", () => {
  const env = makeEnv({});
  assert.equal(env.run("lotBuyable({ ticketsAvailable: 3 })"), true);
  assert.equal(env.run("lotBuyable({ ticketsAvailable: 3, locked: false })"), true);
  assert.equal(env.run("lotBuyable({ ticketsAvailable: 3, locked: true })"), false);
  assert.equal(env.run("lotBuyable({ ticketsAvailable: 0 })"), false);
});

test("listado: «Desde» y «Agotado» cuentan solo lotes comprables", () => {
  const env = makeEnv({});
  const card = (lots) => env.run(`eventCard(${JSON.stringify(event(lots))})`);
  const a = card([lot({ price: 10000 }), lot({ id: "l2", price: 5000, locked: true })]);
  assert.match(a, /\$10\.000/);
  assert.doesNotMatch(a, /Desde|\$5\.000|Agotado/);
  const b = card([lot({ ticketsAvailable: 0 }), lot({ id: "l2", price: 13000, locked: true })]);
  assert.match(b, /Agotado/);
  assert.doesNotMatch(b, /13\.000/);
});

test("checkout con 409 LOT_LOCKED: conserva lo válido, recarga, muestra el mensaje y no deja #/resumen", async () => {
  let loads = 0;
  const lots = () => [lot(), lot({ id: "l2", locked: true })];
  const routes = evRoutes(event(lots()));
  routes["GET /events/fiesta"] = () => { loads++; return { body: { success: true, event: event(lots()) } }; };
  routes["POST /purchases/checkout"] = { status: 409, body: { success: false, code: "LOT_LOCKED", message: "Esa tanda todavía no está habilitada" } };
  const env = makeEnv(routes);
  await flush();
  await env.run("viewBuy('fiesta')");
  const before = loads;
  env.replaced.length = 0;
  env.run("cart = { l1: 1, l2: 2 }; currentEvent = " + JSON.stringify(event(lots())));
  env.get("bEmail").value = "a@b.com"; env.get("bEmail2").value = "a@b.com"; env.get("bName").value = "Ana";
  await env.run("submitBuy({ preventDefault() {} })");
  await flush();
  assert.equal(loads, before + 1, "recarga el evento");
  assert.match(env.get("msg").innerHTML, /Esa tanda todavía no está habilitada/);
  assert.equal(env.run("cart.l1"), 1, "conserva el lote válido");
  assert.equal(env.run("cart.l2"), 0, "pone en 0 el bloqueado");
  assert.deepEqual(env.replaced, [["/e/fiesta"]], "reemplaza el historial sin #/resumen");
});

test("pack: depende solo de su lote; lote agotado => pack «Agotado», sin tocar los de otros lotes", async () => {
  const ev = event([
    lot({ id: "l1", name: "General 1", ticketsAvailable: 0 }),
    lot({ id: "l2", name: "VIP", ticketsAvailable: 8 }),
    lot({ id: "l3", name: "General 3", ticketsAvailable: 3 }),
  ], [
    { id: "p1", lotId: "l1", quantity: 2, discountPercent: 10 },
    { id: "p2", lotId: "l2", quantity: 2, discountPercent: 10 },
    { id: "p3", lotId: "l3", quantity: 5, discountPercent: 10 },
  ]);
  const env = makeEnv(evRoutes(ev));
  await flush();
  await env.run("viewBuy('fiesta')");
  const html = env.get("view").innerHTML;
  const packs = html.split('<div class="ev-lot ev-pack').slice(1);
  const of = (id, name) => packs.find((c) => c.includes(name));
  assert.match(of("p1", "General 1"), /Agotado/);
  assert.doesNotMatch(of("p1", "General 1"), /data-pack/);
  assert.match(of("p2", "VIP"), /data-pack="p2"/); // otro lote agotado no lo afecta
  assert.match(of("p3", "General 3"), /No disponible/); // quedan 3 y el pack es de 5
});
