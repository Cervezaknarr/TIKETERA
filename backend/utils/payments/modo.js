// Integración con MODO (Botón de Pago, SDK v2: el comprador es redirigido al site de pagos)
// Documentación: https://merchants.modo.com.ar/docs/1e2aa881-a70d-4a1d-a8c5-51d1fdbb8e08
//
// Flujo:
//   1. Token: POST /v2/stores/companies/token (username + password, dura una semana)
//   2. POST /v2/payment-requests/ -> id; se redirige al comprador al site de MODO
//   3. MODO hace POST al webhook con la notificación firmada (JWS) y el id
//   4. Se verifica la firma contra las JWKS de MODO y se consulta
//      GET /v2/payment-requests/{id}/data para confirmar el estado final
//
// Cada intento de pago necesita una payment request nueva (el id es de un solo
// uso) y un external_intention_id único: acá es el id de la compra. El gatewayId
// es el id de la payment request de MODO, que es lo que trae el webhook.
// Una payment request dura 10 minutos como máximo y un rechazo la termina, así
// que rechazado = compra fallida (el comprador empieza otra compra).
// Con MODO conviene PURCHASE_HOLD_MINUTES bajo (ej. 15) para liberar el cupo antes

const crypto = require("crypto");
const http = require("./http");

const ENVIRONMENTS = {
  preprod: {
    api: "https://merchants.preprod.playdigital.com.ar",
    site: "https://site.preprod.modo.com.ar/checkout",
  },
  production: {
    api: "https://merchants.playdigital.com.ar",
    site: "https://site.modo.com.ar/checkout",
  },
};

// Mínimo que acepta MODO para crear una payment request (gateways Decidir y Line)
const MIN_AMOUNT = 30;
const JWKS_REFRESH_MS = 10 * 60 * 1000;

// Estados de MODO -> estados internos. Los finales se confirman contra la API
const PENDING_STATUSES = ["CREATED", "SCANNED", "PROCESSING"];
const FINAL_STATUS_MAP = {
  ACCEPTED: "approved",
  REJECTED: "rejected",
  REFUNDED: "rejected",
  // Una devolución parcial no anula las entradas
  PARTIAL_REFUND: "pending",
};

const getConfig = () => {
  const { MODO_USERNAME, MODO_PASSWORD, MODO_PROCESSOR_CODE } = process.env;
  const missing = Object.entries({ MODO_USERNAME, MODO_PASSWORD, MODO_PROCESSOR_CODE })
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length) {
    throw new Error(`MODO: faltan variables de entorno: ${missing.join(", ")}`);
  }

  const environment = process.env.MODO_ENV === "production" ? "production" : "preprod";
  return {
    username: MODO_USERNAME,
    password: MODO_PASSWORD,
    processorCode: MODO_PROCESSOR_CODE,
    ccCode: process.env.MODO_CC_CODE || "1CSI",
    // MODO rechaza los pedidos sin el nombre del comercio en el User-Agent
    merchantName: process.env.MODO_MERCHANT_NAME || "Ticketera",
    environment,
    urls: ENVIRONMENTS[environment],
  };
};

const request = (config, url, options, what, token) =>
  http.request(
    url,
    {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": config.merchantName,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    },
    `MODO: ${what}`
  );

// El token dura una semana y la API limita a 10 pedidos cada 10 minutos: se reutiliza
let cachedToken = null;

const getToken = async (config) => {
  const key = `${config.username}@${config.environment}`;
  if (cachedToken && cachedToken.key === key && cachedToken.expiresAt > Date.now()) {
    return cachedToken.value;
  }

  const data = await request(
    config,
    `${config.urls.api}/v2/stores/companies/token`,
    { method: "POST", body: JSON.stringify({ username: config.username, password: config.password }) },
    "la autenticación"
  );
  if (!data.access_token) throw new Error("MODO: la autenticación no devolvió access_token");

  const ttl = Number(data.expires_in) || 3600;
  cachedToken = {
    key,
    value: data.access_token,
    // Margen de 10 minutos
    expiresAt: Date.now() + Math.max(ttl - 600, 0) * 1000,
  };
  return cachedToken.value;
};

const authorized = async (config, path, options, what) => {
  const token = await getToken(config);
  try {
    return await request(config, `${config.urls.api}${path}`, options, what, token);
  } catch (error) {
    // Token rechazado: se descarta para pedir uno nuevo en el próximo intento
    if (error.status === 401) cachedToken = null;
    throw error;
  }
};

// --- Verificación de la firma del webhook (JWS plano, RFC 7515) ---

// Las JWKS se descargan una vez y se reusan; se vuelven a pedir solo si llega una
// clave desconocida (rotación) y pasaron al menos 10 minutos desde la última vez
let jwks = { keys: new Map(), fetchedAt: 0 };

const loadJwks = async (config) => {
  const data = await request(
    config,
    `${config.urls.api}/v2/payment-requests/.well-known/jwks.json`,
    { method: "GET" },
    "la descarga de las claves de firma"
  );
  const keys = new Map();
  for (const jwk of data.keys || []) {
    keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: "jwk" }));
  }
  jwks = { keys, fetchedAt: Date.now() };
};

const findKey = async (config, kid) => {
  if (!jwks.keys.size) await loadJwks(config);
  let key = jwks.keys.get(kid) || (jwks.keys.size === 1 && !kid ? [...jwks.keys.values()][0] : null);
  if (!key && Date.now() - jwks.fetchedAt > JWKS_REFRESH_MS) {
    await loadJwks(config);
    key = jwks.keys.get(kid);
  }
  return key || null;
};

const ALGORITHMS = {
  RS256: { hash: "sha256" },
  RS384: { hash: "sha384" },
  RS512: { hash: "sha512" },
  ES256: { hash: "sha256", ieee: true },
  ES384: { hash: "sha384", ieee: true },
  ES512: { hash: "sha512", ieee: true },
};

/**
 * Verificar la firma de la notificación y devolver el payload firmado
 * (la única parte en la que se confía). null si la firma no es válida
 */
const verifyNotification = async (config, body) => {
  const jws = body && body.signature;
  let parts;
  if (typeof jws === "string") {
    const [protectedHeader, payload, signature] = jws.split(".");
    parts = { protected: protectedHeader, payload, signature };
  } else if (jws && typeof jws === "object") {
    parts = jws;
  }
  if (!parts || !parts.protected || !parts.payload || !parts.signature) return null;

  try {
    const header = JSON.parse(Buffer.from(parts.protected, "base64url").toString());
    const algorithm = ALGORITHMS[header.alg];
    const key = algorithm && (await findKey(config, header.kid));
    if (!key) return null;

    const valid = crypto.verify(
      algorithm.hash,
      Buffer.from(`${parts.protected}.${parts.payload}`),
      algorithm.ieee ? { key, dsaEncoding: "ieee-p1363" } : key,
      Buffer.from(parts.signature, "base64url")
    );
    if (!valid) return null;

    const payload = JSON.parse(Buffer.from(parts.payload, "base64url").toString());

    // El cuerpo no puede decir otra cosa que lo firmado
    for (const [field, value] of Object.entries(payload)) {
      if (JSON.stringify(body[field]) !== JSON.stringify(value)) return null;
    }
    return payload;
  } catch {
    return null;
  }
};

// Solo ids con forma de id: se usan dentro de una URL
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

module.exports = {
  name: "modo",

  /**
   * Crear la payment request en MODO
   * @param {{ purchase: object, event: object }} data
   * @returns {Promise<{ gatewayId: string, checkoutUrl: string }>}
   */
  async createPayment({ purchase, event }) {
    const config = getConfig();
    const amount = Math.round(Number(purchase.totalPrice) * 100) / 100;
    if (amount < MIN_AMOUNT) {
      throw new Error(`MODO: el monto mínimo para pagar es $${MIN_AMOUNT} (compra de $${amount})`);
    }

    const title = [event.title, purchase.lotName].filter(Boolean).join(" - ");
    const payload = {
      description: `Entradas ${title}`.slice(0, 100),
      amount,
      currency: "ARS",
      cc_code: config.ccCode,
      processor_code: config.processorCode,
      external_intention_id: String(purchase.id),
      items: [{ description: title.slice(0, 100), quantity: purchase.quantity }],
    };
    // A dónde avisa MODO los pagos: tiene que ser una URL pública. Sin esto se usa
    // la que quedó registrada con la tienda (las credenciales de test no tienen ninguna)
    if (process.env.BACKEND_URL) {
      payload.webhook_notification = `${process.env.BACKEND_URL}/api/purchases/webhook`;
    }

    const data = await authorized(
      config,
      "/v2/payment-requests/",
      { method: "POST", body: JSON.stringify(payload) },
      "la creación de la payment request"
    );
    if (!data.id) throw new Error("MODO: la respuesta no incluye el id de la payment request");

    // Los dos retornos (éxito / no exitoso) llevan a la página de las entradas, que
    // muestra si el pago ya se confirmó
    const returnUrl = `${process.env.FRONTEND_URL || "http://localhost:5500"}/#/entradas/${purchase.accessToken}`;
    const checkout = new URL(config.urls.site);
    checkout.searchParams.set("id", data.id);
    checkout.searchParams.set("callbackSuccess", returnUrl);
    checkout.searchParams.set("callback", returnUrl);

    return { gatewayId: String(data.id), checkoutUrl: checkout.toString() };
  },

  /**
   * Interpretar un webhook de MODO. Se verifica la firma y se toma el id del
   * payload firmado; los estados finales se confirman con la API de MODO
   * @returns {Promise<{ gatewayId: string, status: string }|null>} null si no es válido
   */
  async resolveWebhook(req) {
    const config = getConfig();
    const payload = await verifyNotification(config, req.body);
    if (!payload) return null;

    const id = payload.id || payload.payment_request_id || payload.paymentRequestId;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) return null;

    const notified = String(payload.status || "").toUpperCase();
    // Todavía no hay resultado: la API solo informa pagos terminados
    if (PENDING_STATUSES.includes(notified)) return { gatewayId: id, status: "pending" };

    let payment;
    try {
      payment = await authorized(config, `/v2/payment-requests/${id}/data`, { method: "GET" }, "la consulta del pago");
    } catch (error) {
      // Un id inexistente es una notificación inválida (400); cualquier otro
      // error propaga para que MODO reintente el webhook
      if ([400, 404].includes(error.status)) return null;
      throw error;
    }

    const status = FINAL_STATUS_MAP[String(payment.status || "").toUpperCase()];
    if (!status) return null;
    return { gatewayId: id, status };
  },

  // Solo para tests: descarta el token y las claves guardadas
  _reset() {
    cachedToken = null;
    jwks = { keys: new Map(), fetchedAt: 0 };
  },
};
