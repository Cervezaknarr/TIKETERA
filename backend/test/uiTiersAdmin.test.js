// Panel admin: tandas (selector de modo A/B, orden ↑/↓, etiquetas de estado). DOM simulado con node:vm.
// NO prueba layout/CSS ni arrastre real: solo el HTML generado, los payloads y las llamadas a la API.
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
const inlineScripts = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

class El {
  constructor(id) { this.id = id; this.innerHTML = ""; this.textContent = ""; this.value = ""; this.src = ""; this.dataset = {}; this.disabled = false; this.checked = false; this.classList = { add() {}, remove() {}, toggle() {} }; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  appendChild(c) { return c; }
  remove() {}
  focus() {}
  setAttribute() {}
  addEventListener() {}
}
function makeEnv(routes, rows = []) {
  const els = new Map();
  const calls = [];
  const get = (id) => { if (!els.has(id)) els.set(id, new El(id)); return els.get(id); };
  const session = { token: "tok", user: { name: "Admin", role: "admin" } };
  const ctx = {
    document: {
      body: new El("body"), getElementById: get, createElement: () => new El(),
      querySelectorAll: (sel) => (sel === "#lotRows .lotrow" ? rows : []),
    },
    localStorage: { getItem: (k) => (k === "ticketera_session_admin" ? JSON.stringify(session) : null), setItem() {}, removeItem() {} },
    location: { origin: "http://localhost", hash: "", pathname: "/adminGt/", search: "" },
    addEventListener() {}, history: { pushState() {}, replaceState() {} }, navigator: {}, confirm: () => true, prompt: () => null,
    setTimeout, clearTimeout, console, URL, encodeURIComponent, Intl, Date,
    fetch: async (url, opts = {}) => {
      const u = String(url).replace("http://localhost/api", "");
      const method = opts.method || "GET";
      calls.push({ method, url: u, body: opts.body ? JSON.parse(opts.body) : undefined });
      const key = Object.keys(routes).find((k) => k === `${method} ${u}`) || Object.keys(routes).find((k) => `${method} ${u}`.startsWith(k));
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
  for (const [i, s] of inlineScripts(read("adminGt/index.html")).entries()) run(s, `admin#${i}`);
  return { ctx, run, get, calls };
}
const flush = () => new Promise((r) => setTimeout(r, 30));

const lot = (o) => ({ id: "l1", name: "General 1", price: 10000, quantity: 10, ticketsAvailable: 5, afterPrevious: false, locked: false, ...o });
const LOTS = [
  lot({ id: "l1", name: "T1", ticketsAvailable: 0 }),
  lot({ id: "l2", name: "T2 <b>x</b>", afterPrevious: true }),
  lot({ id: "l3", name: "T3", afterPrevious: true, locked: true }),
  lot({ id: "l4", name: "VIP" }),
];
const EV = (lots = LOTS) => ({ id: "e1", title: "Fiesta", location: "Club", description: "d", date: "2030-01-01T20:00:00Z", status: "published", slug: "fiesta", ticketsAvailable: 5, lots });

test("etiquetas: En venta / Próximamente / Agotada + «Espera a la anterior», con nombres escapados (editor y listado)", async () => {
  const env = makeEnv({
    "GET /events?limit=100": { body: { success: true, events: [EV()] } },
    "GET /checkin/events/e1/stats": { body: { success: true, stats: { total: 1, admitted: 0 } } },
    "GET /events/e1": { body: { success: true, event: EV() } },
    "GET /users": { body: { success: true, users: [] } },
  });
  env.run("viewEvents()");
  await flush();
  const list = env.get("view").innerHTML;
  // El listado solo muestra lotes en venta: se ocultan las agotadas y las bloqueadas (Próximamente)
  assert.doesNotMatch(list, /tag soldout">Agotada/);
  assert.match(list, /tag onsale">En venta/);
  assert.doesNotMatch(list, /tag soon">Próximamente/);
  assert.match(list, /class="card ev-admin"/);
  assert.match(list, /class="ev-link"/);
  env.run("viewEdit('e1')");
  await flush();
  const ed = env.get("view").innerHTML;
  assert.equal((ed.match(/tag soon">Próximamente/g) || []).length, 1);
  assert.equal((ed.match(/tag onsale">En venta/g) || []).length, 2); // T2 y VIP
  assert.equal((ed.match(/tag soldout">Agotada/g) || []).length, 1);
  assert.match(ed, /T2 &lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(ed, /Tanda|tierGroup|datalist id="tierGroups"/);
  assert.equal((ed.match(/Espera a la anterior</g) || []).length, 2); // T2 y T3 (modo B)
  assert.match(ed, /Se activa cuando se agote la anterior/);
  assert.match(ed, /Se vende a la vez/);
  assert.match(ed, /Cada lote se vende a la vez que los demás o se activa cuando se agota el de arriba/);
  // selector por lote: el primero deshabilitado y en «a la vez»; T2 en modo B
  const sels = [...ed.matchAll(/<select id="lTier_(\w+)" class="lTierEdit" (disabled)?[^>]*>([\s\S]*?)<\/select>/g)];
  assert.equal(sels.length, 4);
  assert.deepEqual(sels.map((m) => !!m[2]), [true, false, false, false]);
  assert.match(sels[0][3], /<option value="false" selected>/);
  assert.match(sels[1][3], /<option value="true" selected>/);
  assert.match(sels[3][3], /<option value="false" selected>/);
});

test("editor: ↑ deshabilitada en el primero y ↓ en el último", async () => {
  const env = makeEnv({ "GET /events/e1": { body: { success: true, event: EV() } }, "GET /users": { body: { success: true, users: [] } } });
  env.run("viewEdit('e1')");
  await flush();
  const btns = [...env.get("view").innerHTML.matchAll(/<button[^>]*aria-label="(Subir|Bajar)"([^>]*)>/g)].map((m) => [m[1], /disabled/.test(m[2].split("onclick")[0])]);
  assert.deepEqual(btns, [["Subir", true], ["Bajar", false], ["Subir", false], ["Bajar", false], ["Subir", false], ["Bajar", false], ["Subir", false], ["Bajar", true]]);
});

test("↑/↓: PUT lots-order con todos los ids en el nuevo orden y refresca; sin doble clic", async () => {
  const env = makeEnv({
    "GET /events/e1": () => ({ body: { success: true, event: EV() } }),
    "GET /users": { body: { success: true, users: [] } },
    "PUT /events/e1/lots-order": { body: { success: true } },
  });
  env.run("viewEdit('e1')");
  await flush();
  env.run("moveLot('e1','l3',-1)");
  env.run("moveLot('e1','l3',-1)"); // doble clic mientras guarda
  await flush();
  const puts = env.calls.filter((c) => c.method === "PUT");
  assert.equal(puts.length, 1);
  assert.equal(puts[0].url, "/events/e1/lots-order");
  assert.deepEqual(puts[0].body, { order: ["l1", "l3", "l2", "l4"] });
  assert.ok(env.calls.filter((c) => c.url === "/events/e1").length >= 2, "refresca la vista");
  // límites: subir el primero o bajar el último no llama a la API
  env.run("moveLot('e1','l1',-1)");
  env.run("moveLot('e1','l4',1)");
  await flush();
  assert.equal(env.calls.filter((c) => c.method === "PUT").length, 1);
  env.run("moveLot('e1','l1',1)");
  await flush();
  assert.deepEqual(env.calls.filter((c) => c.method === "PUT")[1].body, { order: ["l2", "l1", "l3", "l4"] });
});

test("↑/↓: el 400 del servidor se muestra con flash", async () => {
  const env = makeEnv({
    "GET /events/e1": { body: { success: true, event: EV() } },
    "GET /users": { body: { success: true, users: [] } },
    "PUT /events/e1/lots-order": { status: 400, body: { success: false, message: "Falta un lote" } },
  });
  env.run("viewEdit('e1')");
  await flush();
  env.run("moveLot('e1','l2',1)");
  await flush();
  assert.match(env.get("msg").innerHTML, /msg err[\s\S]*Falta un lote/);
});

test("guardar y agregar lote envían afterPrevious como boolean", async () => {
  const env = makeEnv({
    "GET /events/e1": { body: { success: true, event: EV() } },
    "GET /users": { body: { success: true, users: [] } },
    "PUT /events/e1/lots/l2": { body: { success: true } },
    "POST /events/e1/lots": { body: { success: true } },
  });
  env.run("viewEdit('e1')");
  await flush();
  env.get("lName_l2").value = "T2"; env.get("lPrice_l2").value = "10"; env.get("lQty_l2").value = "10";
  env.get("lTier_l2").value = "true";
  env.run("saveLot('e1','l2')");
  await flush();
  assert.strictEqual(env.calls.find((c) => c.method === "PUT").body.afterPrevious, true);
  env.get("lTier_l2").value = "false";
  env.run("saveLot('e1','l2')");
  await flush();
  assert.strictEqual(env.calls.filter((c) => c.method === "PUT")[1].body.afterPrevious, false);
  env.get("nName").value = "Nuevo"; env.get("nPrice").value = "5"; env.get("nQty").value = "3"; env.get("nTier").value = "true";
  env.run("addLotBtn('e1')");
  await flush();
  assert.strictEqual(env.calls.find((c) => c.method === "POST").body.afterPrevious, true);
  assert.ok(!("tierGroup" in env.calls.find((c) => c.method === "POST").body));
});

test("alta de evento: afterPrevious por fila y orden del formulario, sin llamar a lots-order", async () => {
  const row = (name, tier) => {
    const f = { ".lName": { value: name }, ".lPrice": { value: "10" }, ".lQty": { value: "5" }, ".lTier": { value: tier } };
    return { querySelector: (s) => f[s] };
  };
  const rows = [row("T1", "false"), row("T2", "true"), row("VIP", "false")];
  const env = makeEnv({ "POST /events": { body: { success: true } }, "GET /events": { body: { success: true, events: [] } } }, rows);
  for (const id of ["eTitle", "eDesc", "eLoc", "eMap"]) env.get(id).value = "x";
  env.get("eDate").value = "2030-01-01T20:00"; env.get("eStatus").value = "published"; env.get("eOrganizer").value = ""; env.get("eMinAge").value = "";
  env.run("submitEvent({ preventDefault() {} }, null)");
  await flush();
  const post = env.calls.find((c) => c.method === "POST" && c.url === "/events");
  assert.deepEqual(post.body.lots.map((l) => [l.name, l.afterPrevious]), [["T1", false], ["T2", true], ["VIP", false]]);
  assert.ok(post.body.lots.every((l) => !("tierGroup" in l)));
  assert.ok(!env.calls.some((c) => /lots-order/.test(c.url)));
});

test("alta de evento: ↑/↓ de las filas reordena el formulario y ajusta los botones", () => {
  const mk = (n) => {
    const r = { n, tier: { value: "true", disabled: false }, up: { disabled: false }, down: { disabled: false }, parentNode: null, previousElementSibling: null, nextElementSibling: null };
    r.querySelector = (s) => (s === ".lot-up" ? r.up : s === ".lot-down" ? r.down : s === ".lTier" ? r.tier : null);
    r.closest = () => r;
    return r;
  };
  const rows = [mk(1), mk(2), mk(3)];
  const list = {
    insertBefore(node, ref) { rows.splice(rows.indexOf(node), 1); rows.splice(rows.indexOf(ref), 0, node); relink(); },
  };
  const relink = () => rows.forEach((r, i) => { r.parentNode = list; r.previousElementSibling = rows[i - 1] || null; r.nextElementSibling = rows[i + 1] || null; });
  relink();
  const env = makeEnv({}, rows);
  env.ctx.__r = rows[2];
  env.run("moveLotRow({ closest: () => __r }, -1)");
  assert.deepEqual(rows.map((r) => r.n), [1, 3, 2]);
  assert.deepEqual(rows.map((r) => [r.up.disabled, r.down.disabled]), [[true, false], [false, false], [false, true]]);
  env.ctx.__r = rows[0];
  env.run("moveLotRow({ closest: () => __r }, 1)");
  assert.deepEqual(rows.map((r) => r.n), [3, 1, 2]);
  // el selector del primero queda fijo en «a la vez» y deshabilitado; los demás se habilitan (el que fue primero conserva «a la vez»)
  assert.deepEqual(rows.map((r) => [r.tier.disabled, r.tier.value]), [[true, "false"], [false, "false"], [false, "true"]]);
});
