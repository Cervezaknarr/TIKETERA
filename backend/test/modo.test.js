// Tests de la pasarela MODO con la API simulada y firmas reales (RSA generado acá)
process.env.NODE_ENV = "test";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const modo = require("../utils/payments/modo");

const modoKeys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const modoJwk = {
  ...modoKeys.publicKey.export({ format: "jwk" }),
  kid: "test-key",
  alg: "RS256",
  use: "sig",
};

// Firma un payload como lo haría MODO (JWS plano) y arma el cuerpo del webhook
const signedWebhook = (payload, { key = modoKeys.privateKey, tamper } = {}) => {
  const protectedHeader = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString(
    "base64url"
  );
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .sign("sha256", Buffer.from(`${protectedHeader}.${encodedPayload}`), key)
    .toString("base64url");
  return {
    ...payload,
    ...(tamper || {}),
    signature: { protected: protectedHeader, payload: encodedPayload, signature },
  };
};

const ENV = {
  MODO_USERNAME: "user",
  MODO_PASSWORD: "pass",
  MODO_PROCESSOR_CODE: "P1019",
  MODO_ENV: "preprod",
  MODO_MERCHANT_NAME: "Ticketera Test",
  BACKEND_URL: "https://api.ticketera.test",
  FRONTEND_URL: "https://ticketera.test",
};

// Reemplaza fetch y las variables de entorno mientras corre `fn`
const withModo = async (handler, fn, env = ENV) => {
  const keys = Object.keys(ENV);
  const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const realFetch = globalThis.fetch;
  const calls = [];
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  modo._reset();
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const { status = 200, body } = await handler(url, options);
    return new Response(JSON.stringify(body), { status });
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
    for (const k of keys) {
      if (previous[k] === undefined) delete process.env[k];
      else process.env[k] = previous[k];
    }
  }
};

const modoApi =
  ({ payment = { body: {} } } = {}) =>
  (url) => {
    if (url.endsWith("/v2/stores/companies/token")) {
      return { status: 201, body: { access_token: "tok", token_type: "Bearer", expires_in: 604800 } };
    }
    if (url.endsWith("/jwks.json")) return { body: { keys: [modoJwk] } };
    if (url.endsWith("/v2/payment-requests/")) {
      return { status: 201, body: { id: "pr-12345678", qr: "qr", deeplink: "https://modo.test" } };
    }
    if (url.endsWith("/data")) return payment;
    return { status: 404, body: {} };
  };

test("MODO avisa qué credenciales faltan", async () => {
  await withModo(
    modoApi(),
    async () => {
      await assert.rejects(
        modo.createPayment({ purchase: {}, event: {} }),
        /faltan variables de entorno: MODO_USERNAME, MODO_PASSWORD, MODO_PROCESSOR_CODE/
      );
    },
    {}
  );
});

test("MODO crea la payment request y devuelve la URL del site de pagos", async () => {
  await withModo(modoApi(), async (calls) => {
    const result = await modo.createPayment({
      purchase: {
        id: "11111111-1111-4111-8111-111111111111",
        totalPrice: "2500",
        quantity: 2,
        lotName: "VIP",
        accessToken: "abc",
      },
      event: { title: "Recital" },
    });

    assert.equal(result.gatewayId, "pr-12345678");
    const url = new URL(result.checkoutUrl);
    assert.equal(url.origin + url.pathname, "https://site.preprod.modo.com.ar/checkout");
    assert.equal(url.searchParams.get("id"), "pr-12345678");
    assert.equal(url.searchParams.get("callbackSuccess"), "https://ticketera.test/#/entradas/abc");
    assert.equal(url.searchParams.get("callback"), "https://ticketera.test/#/entradas/abc");

    const create = calls.find((c) => c.url.endsWith("/v2/payment-requests/"));
    assert.equal(create.url, "https://merchants.preprod.playdigital.com.ar/v2/payment-requests/");
    assert.equal(create.options.headers.Authorization, "Bearer tok");
    assert.equal(create.options.headers["User-Agent"], "Ticketera Test");
    const body = JSON.parse(create.options.body);
    assert.equal(body.external_intention_id, "11111111-1111-4111-8111-111111111111");
    assert.equal(body.amount, 2500);
    assert.equal(body.currency, "ARS");
    assert.equal(body.cc_code, "1CSI");
    assert.equal(body.processor_code, "P1019");
    assert.equal(body.webhook_notification, "https://api.ticketera.test/api/purchases/webhook");
    assert.equal(body.items[0].quantity, 2);
    // Se omite el cliente: exige identificación y no la pedimos al comprador
    assert.equal(body.customer, undefined);

    // El token se reutiliza entre pedidos (la API limita 10 cada 10 minutos)
    await modo.createPayment({
      purchase: { id: "x", totalPrice: 100, quantity: 1, accessToken: "a" },
      event: { title: "E" },
    });
    assert.equal(calls.filter((c) => c.url.endsWith("/token")).length, 1);
  });
});

test("MODO rechaza montos menores al mínimo sin llamar a la API", async () => {
  await withModo(modoApi(), async (calls) => {
    await assert.rejects(
      modo.createPayment({
        purchase: { id: "x", totalPrice: 10, quantity: 1, accessToken: "a" },
        event: { title: "E" },
      }),
      /monto mínimo/
    );
    assert.equal(calls.length, 0);
  });
});

test("el webhook de MODO verifica la firma y confirma el estado con la API", async () => {
  const cases = [
    ["ACCEPTED", "approved"],
    ["REJECTED", "rejected"],
    ["REFUNDED", "rejected"],
    ["PARTIAL_REFUND", "pending"],
  ];
  for (const [modoStatus, expected] of cases) {
    await withModo(modoApi({ payment: { body: { status: modoStatus } } }), async (calls) => {
      // Lo que dice la notificación firmada no alcanza: manda el estado de la API
      const body = signedWebhook({ id: "pr-12345678", status: "ACCEPTED" });
      const result = await modo.resolveWebhook({ body });
      assert.deepEqual(result, { gatewayId: "pr-12345678", status: expected }, modoStatus);
      assert.ok(calls.some((c) => c.url.endsWith("/pr-12345678/data")));
    });
  }
});

test("el webhook de MODO no consulta la API mientras el pago está en curso", async () => {
  await withModo(modoApi(), async (calls) => {
    for (const status of ["CREATED", "SCANNED", "PROCESSING"]) {
      const result = await modo.resolveWebhook({
        body: signedWebhook({ id: "pr-12345678", status }),
      });
      assert.deepEqual(result, { gatewayId: "pr-12345678", status: "pending" });
    }
    assert.ok(!calls.some((c) => c.url.endsWith("/data")));
  });
});

test("el webhook de MODO rechaza firmas falsas y cuerpos alterados", async () => {
  await withModo(modoApi({ payment: { body: { status: "ACCEPTED" } } }), async (calls) => {
    const otherKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    const payload = { id: "pr-12345678", status: "REJECTED" };

    const attempts = {
      "sin firma": { id: "pr-12345678", status: "ACCEPTED" },
      "firmado con otra clave": signedWebhook(payload, { key: otherKey }),
      "cuerpo alterado después de firmar": signedWebhook(payload, {
        tamper: { status: "ACCEPTED" },
      }),
      "firma con basura": { ...payload, signature: { protected: "x", payload: "y", signature: "z" } },
    };
    for (const [label, body] of Object.entries(attempts)) {
      assert.equal(await modo.resolveWebhook({ body }), null, label);
    }
    // Ninguna notificación inválida llegó a consultar el pago
    assert.ok(!calls.some((c) => c.url.endsWith("/data")));

    // Id con forma inválida aunque la firma sea buena
    const badId = signedWebhook({ id: "../x", status: "ACCEPTED" });
    assert.equal(await modo.resolveWebhook({ body: badId }), null);
  });
});

test("si MODO falla al consultar el pago, el error propaga para que reintente", async () => {
  await withModo(modoApi({ payment: { status: 503, body: {} } }), async () => {
    const body = signedWebhook({ id: "pr-12345678", status: "ACCEPTED" });
    await assert.rejects(modo.resolveWebhook({ body }), /HTTP 503/);
  });
});
