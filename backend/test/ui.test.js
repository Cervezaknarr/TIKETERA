// Pruebas de UI sin navegador: las páginas se ejecutan en un DOM mínimo simulado (node:vm),
// con fetch simulado. Cubre paneles admin/organizador, cortesías, mapa (mapQuery), pie y terminos.html.
// NO prueba layout/CSS, eventos reales del navegador ni la carga efectiva del iframe de Google.
process.env.DATABASE_URL = "sqlite::memory:";
process.env.JWT_SECRET = "test-secret";
process.env.NODE_ENV = "test";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const FRONT = path.join(__dirname, "..", "..", "frontend");
const read = (f) => fs.readFileSync(path.join(FRONT, f), "utf8");
const PAGES = { admin: "adminGt/index.html", organizador: "organizadorGt/index.html", staff: "staffGt/index.html", publico: "index.html", terminos: "terminos.html" };
const inlineScripts = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

// ---------- DOM mínimo ----------
class El {
  constructor(id) { this.id = id; this.innerHTML = ""; this.textContent = ""; this.value = ""; this.src = ""; this.dataset = {}; this.disabled = false; this.classList = { add() {}, remove() {}, toggle() {} }; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  appendChild(c) { return c; }
  remove() {}
  focus() {}
  setAttribute() {}
  addEventListener() {}
}
function makeEnv({ session, routes = {}, year = true } = {}) {
  const els = new Map();
  const calls = [];
  const get = (id) => { if (!els.has(id)) els.set(id, new El(id)); return els.get(id); };
  const yearEls = year ? [new El("y1"), new El("y2")] : [];
  const store = new Map(session ? [[session.key, JSON.stringify(session.value)]] : []);
  const ctx = {
    document: { body: new El("body"), getElementById: get, querySelectorAll: (sel) => (sel === "[data-year]" ? yearEls : []), createElement: () => new El() },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
    location: { origin: "http://localhost", hash: "", pathname: "/", search: "" },
    addEventListener() {},
    history: { pushState() {}, replaceState() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    confirm: () => true,
    prompt: () => null,
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
  return { ctx, run, get, calls, yearEls };
}
const flush = () => new Promise((r) => setTimeout(r, 20));
const load = (env, page) => {
  env.run(read("common.js"), "common.js");
  for (const [i, s] of inlineScripts(read(page)).entries()) env.run(s, `${page}#${i}`);
};

const EVENT = { id: "11111111-1111-4111-8111-111111111111", title: "Fiesta <b>X</b>", location: "Club", date: "2030-01-01T20:00:00Z", status: "published", mapQuery: null, slug: "fiesta", lots: [], ticketsAvailable: 5 };
const adminSession = { key: "ticketera_session_admin", value: { token: "tok", user: { name: "Admin", role: "admin" } } };
const courtesy = (o = {}) => ({ id: "c1", buyerName: "Ana <img src=x onerror=alert(1)>", buyerEmail: "ana@test.com", quantity: 2, status: "completed", accessToken: "abc", createdAt: "2030-01-01T10:00:00Z", Tickets: [{ code: "AAA", status: "valid" }, { code: "BBB", status: "used", usedAt: "2030-01-01T21:00:00Z" }], ...o });

// ---------- Pie de página y términos ----------
test("pie: todas las páginas tienen footer con copyright, link a /terminos.html y common.js", () => {
  for (const [name, f] of Object.entries(PAGES)) {
    const html = read(f);
    assert.match(html, /<footer class="site-foot">/, name);
    assert.match(html, /<footer[\s\S]*<a href="\/terminos\.html">Términos y condiciones<\/a>[\s\S]*<\/footer>/, name);
    assert.match(html, /<footer[\s\S]*data-year[\s\S]*<\/footer>/, name);
    assert.match(html, /<footer[\s\S]*Gambetech[\s\S]*<\/footer>/, name);
    assert.match(html, /<script src="\/common\.js"><\/script>/, name);
    assert.equal((html.match(/<footer/g) || []).length, 1, `${name}: un solo footer`);
  }
});

test("pie: common.js completa el año actual en [data-year]", () => {
  const env = makeEnv();
  env.run(read("common.js"), "common.js");
  assert.deepEqual(env.yearEls.map((e) => e.textContent), [new Date().getFullYear(), new Date().getFullYear()]);
});

test("terminos.html: estructura, secciones 1 a 8 y enlace de vuelta", () => {
  const html = read("terminos.html");
  assert.match(html, /<title>Términos y condiciones/);
  assert.match(html, /<h2>Términos y condiciones<\/h2>/);
  const h3 = [...html.matchAll(/<h3>(\d+)\. /g)].map((m) => Number(m[1]));
  assert.deepEqual(h3, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.match(html, /<a href="\/"/);
  assert.match(html, /href="\/styles\.css"/);
  assert.match(html, /href="\/event\.css"/);
  for (const f of ["styles.css", "event.css", "common.js"]) assert.ok(fs.existsSync(path.join(FRONT, f)), f);
  assert.equal(inlineScripts(html).length, 0, "sin scripts en línea");
  assert.doesNotMatch(html, /\bTODO\b|lorem/i);
  // HTML balanceado en las etiquetas de bloque principales
  for (const tag of ["main", "article", "header", "footer", "ul"]) {
    assert.equal((html.match(new RegExp(`<${tag}[\\s>]`, "g")) || []).length, (html.match(new RegExp(`</${tag}>`, "g")) || []).length, tag);
  }
});

test("servidor: sirve /terminos.html y los paneles con CSP que permite el mapa de Google", async () => {
  const app = require("../server");
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const { sequelize } = require("../config/database");
  after(async () => { await new Promise((r) => server.close(r)); await sequelize.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const p of ["/terminos.html", "/adminGt/", "/organizadorGt/", "/", "/common.js"]) {
    const res = await fetch(base + p);
    assert.equal(res.status, 200, p);
    await res.text();
  }
  const res = await fetch(base + "/terminos.html");
  const csp = res.headers.get("content-security-policy");
  assert.match(csp, /frame-src https:\/\/www\.google\.com/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match((await res.text()), /Términos y condiciones/);
  assert.equal((await fetch(base + "/no-existe.html")).status, 404);
});

// ---------- Scripts ----------
test("scripts en línea de cada página compilan y cada onclick/oninput llama a una función definida", () => {
  for (const [name, f] of Object.entries(PAGES)) {
    const html = read(f);
    const scripts = inlineScripts(html);
    for (const s of scripts) new vm.Script(s, { filename: f });
    const code = scripts.join("\n") + read("common.js");
    const names = new Set([...html.matchAll(/\bon(?:click|input|change|submit)="([a-zA-Z_$][\w$]*)\(/g)].map((m) => m[1]));
    for (const fn of names) if (fn !== "$") assert.match(code, new RegExp(`(function\\s+${fn}\\b|(const|let|var)\\s+${fn}\\s*=)`), `${name}: ${fn} no definida`);
  }
});

// ---------- Mapa ----------
test("mapSrc: codifica la consulta y apunta al embed de Google", () => {
  const env = makeEnv();
  env.run(read("common.js"), "common.js");
  const src = (q) => env.run(`mapSrc(${JSON.stringify(q)})`);
  assert.equal(src("Av. Siempre Viva 742"), "https://www.google.com/maps?q=Av.%20Siempre%20Viva%20742&output=embed&hl=es");
  const evil = src('x"&output=x><script>alert(1)</script>');
  assert.ok(evil.startsWith("https://www.google.com/maps?q="));
  assert.doesNotMatch(evil.split("&output=embed")[0], /[<>" ]/);
  assert.match(evil, /%22%26output%3Dx%3E%3Cscript%3E/);
  assert.match(src("Café ñandú #1"), /q=Caf%C3%A9%20%C3%B1and%C3%BA%20%231&/);
});

test("público: mapBlock usa mapQuery y si no hay cae al lugar; escapa el título", () => {
  const env = makeEnv();
  env.run(read("common.js"), "common.js");
  // La página pública arranca con router/carrito; se extrae solo mapBlock del script en línea
  const src = inlineScripts(read("index.html")).join("\n").match(/function mapBlock\(e\) \{[\s\S]*?\n\}\n/);
  assert.ok(src, "mapBlock no encontrada en index.html");
  env.run(src[0], "mapBlock");
  const block = (e) => env.run(`mapBlock(${JSON.stringify(e)})`);
  const withQ = block({ location: "Club", mapQuery: "Calle 1, Rosario" });
  assert.match(withQ, /src="https:\/\/www\.google\.com\/maps\?q=Calle%201%2C%20Rosario&/);
  assert.match(withQ, /<iframe[^>]*loading="lazy"[^>]*referrerpolicy=/);
  assert.match(block({ location: "Club Sur", mapQuery: null }), /q=Club%20Sur&/);
  assert.match(block({ location: "Club Sur", mapQuery: "" }), /q=Club%20Sur&/);
  const xss = block({ location: '"><script>alert(1)</script>', mapQuery: null });
  assert.doesNotMatch(xss, /<script>/);
  assert.match(xss, /title="Mapa de &quot;&gt;&lt;script&gt;/);
});

test("admin: el formulario de evento tiene mapQuery (maxlength 200) y la vista previa usa mapSrc con debounce", async () => {
  const html = read("adminGt/index.html");
  assert.match(html, /id="eMap" maxlength="200"/);
  assert.match(html, /id="eMapPreview"/);
  assert.match(html, /mapQuery: \$\('eMap'\)\.value/);
  const env = makeEnv({ session: adminSession, routes: { "GET /events": { body: { success: true, events: [EVENT] } }, "GET /users": { body: { success: true, users: [] } } } });
  load(env, "adminGt/index.html");
  await flush();
  env.run("viewEdit()");
  await flush();
  const form = env.get("view").innerHTML;
  assert.match(form, /id="eMap"/);
  env.get("eLoc").value = "Estadio Único ";
  env.get("eMap").value = "";
  env.run("previewMap()");
  env.run("previewMap()"); // debounce: la segunda llamada cancela la primera
  await new Promise((r) => setTimeout(r, 650));
  assert.equal(env.get("eMapPreview").src, "https://www.google.com/maps?q=Estadio%20%C3%9Anico&output=embed&hl=es");
  env.get("eMap").value = "  Av. Mapa 1 ";
  env.run("previewMap()");
  await new Promise((r) => setTimeout(r, 650));
  assert.match(env.get("eMapPreview").src, /q=Av\.%20Mapa%201&/);
  env.get("eMap").value = "";
  env.get("eLoc").value = "   ";
  env.run("previewMap()");
  await new Promise((r) => setTimeout(r, 650));
  assert.equal(env.get("eMapPreview").src, "about:blank");
});

// ---------- Cortesías (admin) ----------
const courtesyRoutes = (list, extra = {}) => ({
  "GET /events": { body: { success: true, events: [EVENT] } },
  [`GET /courtesies/event/${EVENT.id}`]: () => ({ body: { success: true, event: { id: EVENT.id, title: EVENT.title }, courtesies: list } }),
  ...extra,
});

test("admin cortesías: lista vacía muestra formulario y mensaje vacío", async () => {
  const env = makeEnv({ session: adminSession, routes: courtesyRoutes([]) });
  load(env, "adminGt/index.html");
  await flush();
  env.run(`go('courtesies', '${EVENT.id}')`);
  await flush();
  const v = env.get("view").innerHTML;
  assert.match(v, /Nueva cortesía/);
  assert.match(v, /Todavía no generaste cortesías para este evento/);
  assert.match(v, /id="cQty" type="number" min="1" max="20"/);
  assert.match(v, /submitCourtesy\(event, '11111111-/);
  assert.doesNotMatch(v, /<table>/);
  assert.match(v, /Cortesías · Fiesta &lt;b&gt;X&lt;\/b&gt;/, "título del evento escapado");
});

test("admin cortesías: tabla con activas y anuladas, escapa HTML y solo las activas tienen acciones", async () => {
  const list = [courtesy(), courtesy({ id: "c2", buyerName: "Beto", status: "refunded" })];
  const env = makeEnv({ session: adminSession, routes: courtesyRoutes(list) });
  load(env, "adminGt/index.html");
  await flush();
  env.run(`go('courtesies', '${EVENT.id}')`);
  await flush();
  const v = env.get("view").innerHTML;
  assert.doesNotMatch(v, /<img src=x/);
  assert.match(v, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(v, /Activa/);
  assert.match(v, /Anulada/);
  assert.equal((v.match(/>Enviar mail<\/button>/g) || []).length, 1);
  assert.equal((v.match(/Anular<\/button>/g) || []).length, 1);
  assert.match(v, /AAA/);
  assert.match(v, /BBB ✓/);
  assert.match(v, /sendCourtesy\('11111111-1111-4111-8111-111111111111', 'c1', this\)/);
});

test("admin cortesías: crear envía POST al evento correcto, con cantidad numérica, y recarga la lista", async () => {
  let created = false;
  const routes = courtesyRoutes([], {
    [`POST /courtesies/event/${EVENT.id}`]: () => { created = true; return { status: 201, body: { success: true, courtesy: courtesy() } }; },
  });
  routes[`GET /courtesies/event/${EVENT.id}`] = () => ({ body: { success: true, event: { id: EVENT.id, title: "E" }, courtesies: created ? [courtesy()] : [] } });
  const env = makeEnv({ session: adminSession, routes });
  load(env, "adminGt/index.html");
  await flush();
  env.run(`go('courtesies', '${EVENT.id}')`);
  await flush();
  env.get("cName").value = "Ana";
  env.get("cEmail").value = "ana@test.com";
  env.get("cQty").value = "3";
  let prevented = false;
  env.ctx.__ev = { preventDefault: () => { prevented = true; } };
  env.run(`submitCourtesy(__ev, '${EVENT.id}')`);
  await flush();
  assert.ok(prevented);
  const post = env.calls.find((c) => c.method === "POST");
  assert.equal(post.url, `/courtesies/event/${EVENT.id}`);
  assert.deepEqual(post.body, { name: "Ana", email: "ana@test.com", quantity: 3 });
  assert.match(env.get("view").innerHTML, /Enviar mail/);
  assert.match(env.get("msg").innerHTML, /Cortesía generada/);
});

test("admin cortesías: error del servidor se muestra escapado y no recarga; evento inexistente (404) deja la vista vacía", async () => {
  const routes = courtesyRoutes([], { [`POST /courtesies/event/${EVENT.id}`]: { status: 400, body: { success: false, message: "El email no es válido <x>" } } });
  const env = makeEnv({ session: adminSession, routes });
  load(env, "adminGt/index.html");
  await flush();
  env.run(`go('courtesies', '${EVENT.id}')`);
  await flush();
  env.get("cQty").value = "1";
  env.ctx.__ev = { preventDefault() {} };
  env.run(`submitCourtesy(__ev, '${EVENT.id}')`);
  await flush();
  assert.match(env.get("msg").innerHTML, /msg err.*El email no es válido &lt;x&gt;/);

  const env2 = makeEnv({ session: adminSession, routes: { "GET /events": { body: { success: true, events: [] } } } });
  load(env2, "adminGt/index.html");
  await flush();
  env2.run(`go('courtesies', '22222222-2222-4222-8222-222222222222')`);
  await flush();
  assert.equal(env2.get("view").innerHTML, "");
  assert.match(env2.get("msg").innerHTML, /msg err/);
});

test("admin cortesías: anular pide confirmación (cancelar no llama a la API) y enviar usa la ruta del evento", async () => {
  const env = makeEnv({
    session: adminSession,
    routes: courtesyRoutes([courtesy()], {
      [`POST /courtesies/event/${EVENT.id}/c1/void`]: { body: { success: true } },
      [`POST /courtesies/event/${EVENT.id}/c1/send`]: { body: { success: true, message: "Entradas enviadas a a***@test.com" } },
    }),
  });
  load(env, "adminGt/index.html");
  await flush();
  env.run(`go('courtesies', '${EVENT.id}')`);
  await flush();
  env.ctx.__btn = new El("b");
  env.ctx.__btn.dataset = { name: "Ana", email: "ana@test.com" };
  env.ctx.confirm = () => false;
  env.run(`voidCourtesy('${EVENT.id}', 'c1', __btn)`);
  env.run(`sendCourtesy('${EVENT.id}', 'c1', __btn)`);
  await flush();
  assert.equal(env.calls.filter((c) => c.method === "POST").length, 0);
  env.ctx.confirm = () => true;
  env.run(`sendCourtesy('${EVENT.id}', 'c1', __btn)`);
  await flush();
  assert.ok(env.calls.some((c) => c.url === `/courtesies/event/${EVENT.id}/c1/send`));
  assert.match(env.get("msg").innerHTML, /Entradas enviadas a a\*\*\*@test\.com/);
  assert.equal(env.ctx.__btn.disabled, false);
  env.run(`voidCourtesy('${EVENT.id}', 'c1', __btn)`);
  await flush();
  assert.ok(env.calls.some((c) => c.url === `/courtesies/event/${EVENT.id}/c1/void`));
  assert.match(env.get("msg").innerHTML, /Cortesía anulada/);
});

test("admin: el listado de eventos y el de compradores enlazan a Cortesías con el id del evento", () => {
  const html = read("adminGt/index.html");
  assert.match(html, /onclick="go\('courtesies','\$\{e\.id\}'\)">Cortesías/);
  assert.match(html, /onclick="go\('courtesies','\$\{buyers\.event\.id\}'\)">Cortesías/);
  assert.match(html, /courtesies: viewCourtesies/);
});

// ---------- Panel organizador ----------
test("organizador: sin sesión muestra login; no expone cortesías (solo admin) ni llama a /courtesies", async () => {
  const html = read("organizadorGt/index.html");
  assert.doesNotMatch(html, /courtesies|Cortesías/i);
  const env = makeEnv();
  load(env, "organizadorGt/index.html");
  await flush();
  assert.match(env.get("view").innerHTML, /id="loginForm"/);
  assert.equal(env.calls.length, 0);
});

test("organizador: con sesión lista sus eventos escapando HTML y con las acciones propias", async () => {
  const session = { key: "ticketera_session_organizador", value: { token: "t", user: { name: "Org", role: "organizer" } } };
  const html = read("organizadorGt/index.html");
  const key = (html.match(/createSession\('(\w+)'\)/) || [])[1];
  session.key = "ticketera_session_" + key;
  const env = makeEnv({
    session,
    routes: {
      "GET /organizer/events": { body: { success: true, events: [EVENT] } },
      "GET /purchases/event": { body: { success: true, purchases: [], buyers: [] } },
    },
  });
  load(env, "organizadorGt/index.html");
  await flush();
  const v = env.get("view").innerHTML;
  assert.match(v, /Fiesta &lt;b&gt;X&lt;\/b&gt;/);
  assert.doesNotMatch(v, /<b>X<\/b>/);
  assert.match(v, /Compradores/);
  assert.match(v, /Staff/);
  assert.match(v, /Pagos/);
  assert.doesNotMatch(v, /Cortes/);
});
