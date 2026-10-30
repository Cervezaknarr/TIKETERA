// Integración con Nave (Checkout online por API)
// Documentación: https://developer-portal-doc-mfe-website-mfe.ranty.io/nave/online-payments/checkout
//
// Flujo:
//   1. Token (client credentials: client_id + client_secret + audience)
//   2. POST /payment_requests/ecommerce -> checkout_url, se redirige al comprador
//   3. Nave hace POST al webhook con { payment_id, payment_check_url, external_payment_id }
//   4. Se consulta GET /payments/{payment_id} y el estado real sale de esa respuesta
//
// El external_payment_id que se manda a Nave es el id de la compra, y es también
// el gatewayId con el que se busca la compra cuando llega el webhook

const http = require("./http");

const ENVIRONMENTS = {
  sandbox: {
    auth: "https://homoservices.apinaranja.com/security-ms/api/security/auth0/b2b/m2msPrivate",
    api: "https://api-sandbox.ranty.io/integrations",
  },
  production: {
    auth: "https://services.apinaranja.com/security-ms/api/security/auth0/b2b/m2msPrivate",
    api: "https://api.ranty.io/integrations",
  },
};

const { paymentWindowMinutes } = require("../paymentWindow");

// Estados de un pago de Nave -> estados internos.
// REJECTED queda como "pending" a propósito: Nave permite reintentar el pago
// sobre la misma intención, y si se liberara el cupo acá, un reintento aprobado
// después cobraría sin emitir entradas
const STATUS_MAP = {
  APPROVED: "approved",
  PENDING: "pending",
  REJECTED: "pending",
  CANCELLED: "rejected",
  PURCHASE_REVERSED: "rejected",
  REFUNDED: "rejected",
  CHARGEBACK_REVIEW: "pending",
  CHARGED_BACK: "rejected",
};

const getConfig = () => {
  const { NAVE_CLIENT_ID, NAVE_CLIENT_SECRET, NAVE_AUDIENCE, NAVE_POS_ID } = process.env;
  const missing = Object.entries({
    NAVE_CLIENT_ID,
    NAVE_CLIENT_SECRET,
    NAVE_AUDIENCE,
    NAVE_POS_ID,
  })
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length) {
    throw new Error(`Nave: faltan variables de entorno: ${missing.join(", ")}`);
  }

  const environment = process.env.NAVE_ENV === "production" ? "production" : "sandbox";
  return {
    clientId: NAVE_CLIENT_ID,
    clientSecret: NAVE_CLIENT_SECRET,
    audience: NAVE_AUDIENCE,
    posId: NAVE_POS_ID,
    urls: ENVIRONMENTS[environment],
    environment,
  };
};

// Con timeout y reintentos ante errores de red o 5xx (recomendado por Nave)
const request = (url, options, what) => http.request(url, options, `Nave: ${what}`);

// El token dura 24 hs: se reutiliza hasta poco antes de que venza
let cachedToken = null;

const getToken = async (config) => {
  if (cachedToken && cachedToken.key === config.clientId + config.environment) {
    if (cachedToken.expiresAt > Date.now()) return cachedToken.value;
  }

  const data = await request(
    config.urls.auth,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        audience: config.audience,
      }),
    },
    "la autenticación"
  );
  if (!data.access_token) throw new Error("Nave: la autenticación no devolvió access_token");

  const ttl = Number(data.expires_in) || 3600;
  cachedToken = {
    key: config.clientId + config.environment,
    value: data.access_token,
    // Margen de 5 minutos
    expiresAt: Date.now() + Math.max(ttl - 300, 0) * 1000,
  };
  return cachedToken.value;
};

const authorizedRequest = async (config, path, options, what) => {
  const token = await getToken(config);
  try {
    return await request(
      `${config.urls.api}${path}`,
      {
        ...options,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      },
      what
    );
  } catch (error) {
    // Token rechazado: se descarta para pedir uno nuevo en el próximo intento
    if (error.status === 401) cachedToken = null;
    throw error;
  }
};

// Nave pide los montos como string con dos decimales
const money = (value) => Number(value).toFixed(2);

const returnUrl = (purchase) =>
  `${process.env.FRONTEND_URL || "http://localhost:5500"}/#/entradas/${purchase.accessToken}`;

module.exports = {
  name: "nave",

  /**
   * Crear la intención de pago en Nave
   * @param {{ purchase: object, event: object, items?: object[] }} data
   *   items: líneas de la compra { lotName, unitPrice, quantity }; sin ellas se usa la compra entera
   * @returns {Promise<{ gatewayId: string, checkoutUrl: string }>}
   */
  async createPayment({ purchase, event, items }) {
    const config = getConfig();
    const total = money(purchase.totalPrice);
    const lines = items && items.length
      ? items
      : [{ lotName: purchase.lotName, unitPrice: purchase.totalPrice / purchase.quantity, quantity: purchase.quantity }];

    const payload = {
      external_payment_id: String(purchase.id),
      seller: { pos_id: config.posId },
      transactions: [
        {
          amount: { currency: "ARS", value: total },
          products: lines.map((line) => ({
            name: [event.title, line.lotName].filter(Boolean).join(" - ").slice(0, 100),
            description: `Entrada ${line.lotName || ""} para ${event.title}`.replace(/\s+/g, " ").slice(0, 200),
            quantity: line.quantity,
            unit_price: { currency: "ARS", value: money(line.unitPrice) },
          })),
        },
      ],
      buyer: {
        name: purchase.buyerName,
        user_email: purchase.buyerEmail,
      },
      additional_info: { callback_url: returnUrl(purchase) },
      duration_time: paymentWindowMinutes() * 60,
    };

    const data = await authorizedRequest(
      config,
      "/payment_requests/ecommerce",
      { method: "POST", body: JSON.stringify(payload) },
      "la creación de la intención de pago"
    );
    if (!data.checkout_url) throw new Error("Nave: la respuesta no incluye checkout_url");

    return { gatewayId: String(purchase.id), checkoutUrl: data.checkout_url };
  },

  /**
   * Interpretar un webhook de Nave. Nave no firma las notificaciones, así que del
   * body solo se toma el payment_id y el estado real se consulta a la API con las
   * credenciales del comercio. Tampoco se sigue el payment_check_url del body
   * @returns {Promise<{ gatewayId: string, status: string }|null>} null si no es válido
   */
  async resolveWebhook(req) {
    const config = getConfig();
    const paymentId = req.body && req.body.payment_id;

    // El id se usa dentro de una URL: solo se aceptan ids con forma de id
    if (typeof paymentId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(paymentId)) {
      return null;
    }

    let payment;
    try {
      payment = await authorizedRequest(
        config,
        `/payments/${paymentId}`,
        { method: "GET" },
        "la consulta del pago"
      );
    } catch (error) {
      // Un id inexistente es una notificación inválida (400); cualquier otro
      // error propaga para que Nave reintente el webhook
      if ([400, 404].includes(error.status)) return null;
      throw error;
    }

    const status = STATUS_MAP[payment.status && payment.status.name];
    if (!payment.external_payment_id || !status) return null;

    return { gatewayId: String(payment.external_payment_id), status };
  },
};
