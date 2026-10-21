// Tests del checkout y la capa de pasarelas de pago, con SQLite en memoria
process.env.DATABASE_URL = "sqlite::memory:";
process.env.JWT_SECRET = "test-secret";
process.env.NODE_ENV = "test";
process.env.RESEND_API_KEY = ""; // Email inactivo

const { test, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const app = require("../server");
const { sequelize } = require("../config/database");
const User = require("../models/User");
const Event = require("../models/Event");
const Purchase = require("../models/Purchase");
const Ticket = require("../models/Ticket");
const { setProvider } = require("../utils/payments");
const mock = require("../utils/payments/mock");

let server;
let baseUrl;
let organizer;

const post = async (path, body) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const newEvent = (ticketsAvailable) =>
  Event.create({
    title: "Evento",
    description: "Prueba",
    date: new Date(Date.now() + 86400000),
    location: "Salón",
    ticketPrice: 1000,
    ticketsAvailable,
    userId: organizer.id,
  });

const checkout = (event, quantity, name = "Comprador") =>
  post("/api/purchases/checkout", {
    eventId: event.id,
    buyerName: name,
    buyerEmail: "comprador@test.com",
    quantity,
  });

before(async () => {
  await sequelize.sync({ force: true });
  organizer = await User.create({
    name: "Organizador",
    email: "org@test.com",
    password: "secret",
  });
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => setProvider(null));

after(async () => {
  server.close();
  await sequelize.close();
});

// SQLite en memoria usa una sola conexión y no admite transacciones simultáneas,
// por eso las compras son secuenciales. La atomicidad ante compras realmente
// concurrentes depende del UPDATE condicional y hay que verificarla con Postgres
test("no se vende más cupo del que hay", async () => {
  const event = await newEvent(5);

  const first = await checkout(event, 3, "A");
  const second = await checkout(event, 3, "B");
  const third = await checkout(event, 2, "C");

  assert.equal(first.status, 201);
  assert.equal(second.status, 400);
  assert.match(second.body.message, /Solo quedan 2 entradas/);
  assert.equal(third.status, 201);
  assert.equal((await Event.findByPk(event.id)).ticketsAvailable, 0);

  const soldOut = await checkout(event, 1, "D");
  assert.equal(soldOut.status, 400);
  assert.equal(await Purchase.count({ where: { eventId: event.id } }), 2);
});

test("el checkout rechaza cantidades inválidas sin tocar el cupo", async () => {
  const event = await newEvent(10);

  for (const quantity of [0, -1, 1.5, "2", null]) {
    const res = await checkout(event, quantity);
    assert.equal(res.status, 400, `quantity=${JSON.stringify(quantity)}`);
  }
  assert.equal((await Event.findByPk(event.id)).ticketsAvailable, 10);
});

test("con una pasarela real el checkout devuelve su URL de pago", async () => {
  setProvider({
    name: "fake",
    createPayment: async ({ purchase }) => ({
      gatewayId: `fake_${purchase.id}`,
      checkoutUrl: "https://pasarela.test/pagar/123",
    }),
    resolveWebhook: async () => null,
  });
  const event = await newEvent(10);

  const res = await checkout(event, 2);
  assert.equal(res.status, 201);
  assert.equal(res.body.checkoutUrl, "https://pasarela.test/pagar/123");
  assert.match(res.body.purchase.paymentGatewayId, /^fake_/);
});

test("si la pasarela falla al crear el pago, se libera el cupo", async () => {
  setProvider({
    name: "fake",
    createPayment: async () => {
      throw new Error("pasarela caída");
    },
    resolveWebhook: async () => null,
  });
  const event = await newEvent(10);

  const res = await checkout(event, 4);
  assert.equal(res.status, 500);
  assert.equal((await Event.findByPk(event.id)).ticketsAvailable, 10);
  const purchase = await Purchase.findOne({ where: { eventId: event.id } });
  assert.equal(purchase.status, "failed");
});

test("el webhook usa el estado verificado por la pasarela, no el del body", async () => {
  // La pasarela dice que el pago fue rechazado, aunque el body diga "approved"
  setProvider({
    name: "fake",
    createPayment: async ({ purchase }) => ({
      gatewayId: `fake_${purchase.id}`,
      checkoutUrl: "https://pasarela.test/pagar",
    }),
    resolveWebhook: async (req) => ({
      gatewayId: req.body.paymentGatewayId,
      status: "rejected",
    }),
  });
  const event = await newEvent(10);
  const { body } = await checkout(event, 2);

  const res = await post("/api/purchases/webhook", {
    paymentGatewayId: body.purchase.paymentGatewayId,
    status: "approved",
  });
  assert.equal(res.status, 200);

  const purchase = await Purchase.findByPk(body.purchase.id);
  assert.equal(purchase.status, "failed");
  assert.equal(await Ticket.count({ where: { purchaseId: purchase.id } }), 0);
  assert.equal((await Event.findByPk(event.id)).ticketsAvailable, 10);
});

test("un webhook inválido se rechaza y uno pendiente no cambia nada", async () => {
  setProvider({
    name: "fake",
    createPayment: async ({ purchase }) => ({ gatewayId: `fake_${purchase.id}`, checkoutUrl: "x" }),
    resolveWebhook: async (req) =>
      req.body.valido ? { gatewayId: req.body.id, status: "pending" } : null,
  });
  const event = await newEvent(10);
  const { body } = await checkout(event, 1);

  const invalid = await post("/api/purchases/webhook", { id: body.purchase.paymentGatewayId });
  assert.equal(invalid.status, 400);

  const pending = await post("/api/purchases/webhook", {
    valido: true,
    id: body.purchase.paymentGatewayId,
  });
  assert.equal(pending.status, 200);
  assert.equal((await Purchase.findByPk(body.purchase.id)).status, "pending");
});

test("la pasarela simulada no funciona en producción", async () => {
  process.env.NODE_ENV = "production";
  try {
    await assert.rejects(mock.createPayment(), /no está permitido en producción/);
    await assert.rejects(
      mock.resolveWebhook({ body: { paymentGatewayId: "x", status: "approved" } }),
      /no está permitido en producción/
    );
  } finally {
    process.env.NODE_ENV = "test";
  }
});

test("la pasarela de Nave avisa qué credenciales faltan", async () => {
  const nave = require("../utils/payments/nave");
  await assert.rejects(
    nave.createPayment({ purchase: {}, event: {} }),
    /faltan variables de entorno: NAVE_CLIENT_ID, NAVE_CLIENT_SECRET, NAVE_AUDIENCE, NAVE_POS_ID/
  );
});

// --- Nave con la API simulada (fetch reemplazado) ---

const withNave = async (handler, fn) => {
  const env = {
    NAVE_CLIENT_ID: "id",
    NAVE_CLIENT_SECRET: "secret",
    NAVE_AUDIENCE: "aud",
    NAVE_POS_ID: "pos-1",
    NAVE_ENV: "sandbox",
  };
  const previous = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  const realFetch = globalThis.fetch;
  const calls = [];
  Object.assign(process.env, env);
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const { status = 200, body } = await handler(url, options);
    return new Response(JSON.stringify(body), { status });
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

const naveApi = (payment) => (url) => {
  if (url.includes("m2msPrivate")) {
    return { body: { access_token: "tok", expires_in: "86400", token_type: "Bearer" } };
  }
  if (url.endsWith("/payment_requests/ecommerce")) {
    return { body: { id: "req-1", checkout_url: "https://nave.test/checkout?id=req-1" } };
  }
  if (url.includes("/payments/")) return payment;
  return { status: 404, body: {} };
};

test("Nave crea la intención de pago con el monto y la compra", async () => {
  // Se reinicia el módulo para no arrastrar el token cacheado de otros tests
  delete require.cache[require.resolve("../utils/payments/nave")];
  const nave = require("../utils/payments/nave");

  await withNave(naveApi({ body: {} }), async (calls) => {
    const result = await nave.createPayment({
      purchase: {
        id: "11111111-1111-4111-8111-111111111111",
        totalPrice: "2500",
        quantity: 2,
        buyerName: "Ana",
        buyerEmail: "ana@test.com",
        accessToken: "abc",
      },
      event: { title: "Recital" },
    });

    assert.deepEqual(result, {
      gatewayId: "11111111-1111-4111-8111-111111111111",
      checkoutUrl: "https://nave.test/checkout?id=req-1",
    });

    const create = calls.find((c) => c.url.endsWith("/payment_requests/ecommerce"));
    assert.equal(create.options.headers.Authorization, "Bearer tok");
    const body = JSON.parse(create.options.body);
    assert.equal(body.external_payment_id, "11111111-1111-4111-8111-111111111111");
    assert.equal(body.seller.pos_id, "pos-1");
    assert.equal(body.transactions[0].amount.value, "2500.00");
    assert.equal(body.transactions[0].products[0].unit_price.value, "1250.00");
    assert.match(body.additional_info.callback_url, /#\/entradas\/abc$/);
  });
});

test("el webhook de Nave consulta el pago y mapea su estado", async () => {
  delete require.cache[require.resolve("../utils/payments/nave")];
  const nave = require("../utils/payments/nave");
  const notification = { body: { payment_id: "pay-12345678", payment_check_url: "https://evil.test" } };

  const cases = [
    ["APPROVED", "approved"],
    ["REJECTED", "pending"], // Nave permite reintentar el pago
    ["CANCELLED", "rejected"],
    ["PENDING", "pending"],
  ];
  for (const [naveStatus, expected] of cases) {
    await withNave(
      naveApi({ body: { external_payment_id: "compra-1", status: { name: naveStatus } } }),
      async (calls) => {
        const result = await nave.resolveWebhook(notification);
        assert.deepEqual(result, { gatewayId: "compra-1", status: expected }, naveStatus);
        // Solo se llama a la API de Nave, nunca al payment_check_url del body
        assert.ok(calls.every((c) => !c.url.includes("evil.test")));
      }
    );
  }
});

test("el webhook de Nave rechaza ids inválidos y pagos inexistentes", async () => {
  delete require.cache[require.resolve("../utils/payments/nave")];
  const nave = require("../utils/payments/nave");

  await withNave(naveApi({ status: 404, body: {} }), async (calls) => {
    for (const body of [{}, { payment_id: 5 }, { payment_id: "../../x" }]) {
      assert.equal(await nave.resolveWebhook({ body }), null);
    }
    assert.equal(calls.length, 0);

    // Id con forma válida pero que Nave no conoce
    assert.equal(await nave.resolveWebhook({ body: { payment_id: "pay-12345678" } }), null);
  });
});

test("si Nave falla al consultar el pago, el error propaga para que reintente", async () => {
  delete require.cache[require.resolve("../utils/payments/nave")];
  const nave = require("../utils/payments/nave");

  await withNave(naveApi({ status: 503, body: {} }), async () => {
    await assert.rejects(
      nave.resolveWebhook({ body: { payment_id: "pay-12345678" } }),
      /HTTP 503/
    );
  });
});

// --- Mercado Pago con la API simulada (fetch reemplazado) ---

const withMercadoPago = async (handler, fn) => {
  const previous = process.env.MERCADOPAGO_ACCESS_TOKEN;
  const previousBackend = process.env.BACKEND_URL;
  const realFetch = globalThis.fetch;
  const calls = [];
  process.env.MERCADOPAGO_ACCESS_TOKEN = "TEST-token";
  process.env.BACKEND_URL = "https://api.ticketera.test";
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const { status = 200, body } = await handler(url, options);
    return new Response(JSON.stringify(body), { status });
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
    if (previous === undefined) delete process.env.MERCADOPAGO_ACCESS_TOKEN;
    else process.env.MERCADOPAGO_ACCESS_TOKEN = previous;
    if (previousBackend === undefined) delete process.env.BACKEND_URL;
    else process.env.BACKEND_URL = previousBackend;
  }
};

test("Mercado Pago avisa si falta el access token", async () => {
  const mp = require("../utils/payments/mercadopago");
  await assert.rejects(
    mp.createPayment({ purchase: {}, event: {} }),
    /faltan variables de entorno: MERCADOPAGO_ACCESS_TOKEN/
  );
});

test("Mercado Pago crea la preferencia con la compra como referencia", async () => {
  const mp = require("../utils/payments/mercadopago");

  await withMercadoPago(
    () => ({ body: { id: "pref-1", init_point: "https://mp.test/checkout?pref=pref-1" } }),
    async (calls) => {
      const result = await mp.createPayment({
        purchase: {
          id: "11111111-1111-4111-8111-111111111111",
          totalPrice: "2500",
          quantity: 2,
          buyerName: "Ana",
          buyerEmail: "ana@test.com",
          accessToken: "abc",
        },
        event: { title: "Recital" },
      });

      assert.deepEqual(result, {
        gatewayId: "11111111-1111-4111-8111-111111111111",
        checkoutUrl: "https://mp.test/checkout?pref=pref-1",
      });

      const { url, options } = calls[0];
      assert.equal(url, "https://api.mercadopago.com/checkout/preferences");
      assert.equal(options.headers.Authorization, "Bearer TEST-token");
      const body = JSON.parse(options.body);
      assert.equal(body.external_reference, "11111111-1111-4111-8111-111111111111");
      assert.equal(body.items[0].unit_price, 1250);
      assert.equal(body.items[0].quantity, 2);
      assert.equal(body.notification_url, "https://api.ticketera.test/api/purchases/webhook");
      assert.match(body.back_urls.success, /#\/entradas\/abc$/);
    }
  );
});

test("el webhook de Mercado Pago consulta el pago y mapea su estado", async () => {
  const mp = require("../utils/payments/mercadopago");

  const cases = [
    ["approved", "approved"],
    ["rejected", "pending"], // el comprador puede reintentar con otra tarjeta
    ["in_process", "pending"],
    ["cancelled", "rejected"],
  ];
  for (const [mpStatus, expected] of cases) {
    await withMercadoPago(
      () => ({ body: { status: mpStatus, external_reference: "compra-1" } }),
      async (calls) => {
        // El id llega en el query o en el body
        for (const req of [
          { query: { type: "payment", "data.id": "123456" }, body: {} },
          { query: {}, body: { type: "payment", data: { id: 123456 } } },
        ]) {
          calls.length = 0;
          const result = await mp.resolveWebhook(req);
          assert.deepEqual(result, { gatewayId: "compra-1", status: expected }, mpStatus);
          assert.equal(calls[0].url, "https://api.mercadopago.com/v1/payments/123456");
        }
      }
    );
  }
});

test("el webhook de Mercado Pago rechaza notificaciones inválidas", async () => {
  const mp = require("../utils/payments/mercadopago");

  await withMercadoPago(() => ({ status: 404, body: {} }), async (calls) => {
    const invalid = [
      { query: {}, body: {} },
      { query: { type: "merchant_order", "data.id": "1" }, body: {} }, // otro tipo de aviso
      { query: { type: "payment", "data.id": "../x" }, body: {} },
    ];
    for (const req of invalid) assert.equal(await mp.resolveWebhook(req), null);
    assert.equal(calls.length, 0);

    // Id con forma válida pero que Mercado Pago no conoce
    assert.equal(
      await mp.resolveWebhook({ query: { type: "payment", "data.id": "999" }, body: {} }),
      null
    );
  });
});

// --- Compras vencidas ---

const { releaseExpiredPurchases } = require("../utils/purchases");

const approvingProvider = () =>
  setProvider({
    name: "fake",
    createPayment: async ({ purchase }) => ({
      gatewayId: `fake_${purchase.id}`,
      checkoutUrl: "https://pasarela.test/pagar",
    }),
    resolveWebhook: async (req) => ({ gatewayId: req.body.id, status: "approved" }),
  });

// Hace que una compra parezca creada hace `minutes` minutos
const age = (purchase, minutes) =>
  Purchase.update(
    { createdAt: new Date(Date.now() - minutes * 60 * 1000) },
    { where: { id: purchase.id }, silent: true }
  );

test("las compras pendientes vencidas liberan su cupo y las recientes no", async () => {
  approvingProvider();
  const event = await newEvent(10);
  const old = (await checkout(event, 3, "Vieja")).body.purchase;
  const recent = (await checkout(event, 2, "Reciente")).body.purchase;
  await age({ id: old.id }, 120);
  assert.equal((await Event.findByPk(event.id)).ticketsAvailable, 5);

  assert.equal(await releaseExpiredPurchases(), 1);

  assert.equal((await Purchase.findByPk(old.id)).status, "failed");
  assert.equal((await Purchase.findByPk(recent.id)).status, "pending");
  assert.equal((await Event.findByPk(event.id)).ticketsAvailable, 8);

  // Una segunda pasada no libera dos veces
  assert.equal(await releaseExpiredPurchases(), 0);
  assert.equal((await Event.findByPk(event.id)).ticketsAvailable, 8);
});

test("las compras ya pagadas no se liberan aunque sean viejas", async () => {
  approvingProvider();
  const event = await newEvent(10);
  const { purchase } = (await checkout(event, 2)).body;
  await post("/api/purchases/webhook", { id: purchase.paymentGatewayId });
  await age({ id: purchase.id }, 120);

  assert.equal(await releaseExpiredPurchases(), 0);
  assert.equal((await Purchase.findByPk(purchase.id)).status, "completed");
  assert.equal((await Event.findByPk(event.id)).ticketsAvailable, 8);
});

test("un pago aprobado tras vencer la compra la recupera si queda cupo", async () => {
  approvingProvider();
  const event = await newEvent(10);
  const { purchase } = (await checkout(event, 2)).body;
  await age({ id: purchase.id }, 120);
  await releaseExpiredPurchases();
  assert.equal((await Event.findByPk(event.id)).ticketsAvailable, 10);

  const res = await post("/api/purchases/webhook", { id: purchase.paymentGatewayId });
  assert.equal(res.status, 200);

  assert.equal((await Purchase.findByPk(purchase.id)).status, "completed");
  assert.equal(await Ticket.count({ where: { purchaseId: purchase.id } }), 2);
  assert.equal((await Event.findByPk(event.id)).ticketsAvailable, 8);
});

test("un pago aprobado tras vencer sin cupo no emite entradas y avisa", async () => {
  approvingProvider();
  const event = await newEvent(3);
  const { purchase } = (await checkout(event, 3)).body;
  await age({ id: purchase.id }, 120);
  await releaseExpiredPurchases();
  // Otra persona se queda con las 3 entradas
  assert.equal((await checkout(event, 3, "Otra")).status, 201);

  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  let res;
  try {
    res = await post("/api/purchases/webhook", { id: purchase.paymentGatewayId });
  } finally {
    console.error = original;
  }

  assert.equal(res.status, 200);
  assert.match(res.body.message, /requiere reembolso/);
  assert.match(errors.join("\n"), /PAGO APROBADO SIN CUPO/);
  assert.equal((await Purchase.findByPk(purchase.id)).status, "failed");
  assert.equal(await Ticket.count({ where: { purchaseId: purchase.id } }), 0);
  assert.equal((await Event.findByPk(event.id)).ticketsAvailable, 0);
});
