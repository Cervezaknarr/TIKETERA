// Integración con Mercado Pago (Checkout Pro)
// Documentación: https://www.mercadopago.com.ar/developers/es/docs/checkout-pro
//
// Flujo:
//   1. POST /checkout/preferences -> init_point, se redirige al comprador
//   2. Mercado Pago hace POST al webhook con el id del pago (data.id)
//   3. Se consulta GET /v1/payments/{id} y el estado real sale de esa respuesta
//
// La compra viaja como external_reference, y es también el gatewayId con el que
// se busca la compra cuando llega el webhook

const { request } = require("./http");

const { paymentWindowMinutes } = require("../paymentWindow");

const API = "https://api.mercadopago.com";

// Estados de un pago de Mercado Pago -> estados internos.
// "rejected" queda como "pending" a propósito: el comprador puede reintentar con
// otra tarjeta sobre la misma preferencia, y si se liberara el cupo acá, un
// reintento aprobado después cobraría sin emitir entradas
const STATUS_MAP = {
  approved: "approved",
  authorized: "pending",
  pending: "pending",
  in_process: "pending",
  in_mediation: "pending",
  rejected: "pending",
  cancelled: "rejected",
  refunded: "rejected",
  charged_back: "rejected",
};

const getConfig = () => {
  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error("Mercado Pago: faltan variables de entorno: MERCADOPAGO_ACCESS_TOKEN");
  }
  return { accessToken };
};

const api = (config, path, options, what) =>
  request(
    `${API}${path}`,
    {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.accessToken}`,
      },
    },
    `Mercado Pago: ${what}`
  );

// El id del pago llega en el query (?data.id=123) o en el body ({ data: { id } })
const paymentIdFrom = (req) => {
  const body = req.body || {};
  const query = req.query || {};
  const type = query.type || query.topic || body.type || body.topic;
  if (type !== "payment") return null;

  const id = query["data.id"] || query.id || (body.data && body.data.id);
  // El id se usa dentro de una URL: solo se aceptan ids numéricos
  return /^\d{1,20}$/.test(String(id)) ? String(id) : null;
};

module.exports = {
  name: "mercadopago",

  /**
   * Crear la preferencia de pago en Mercado Pago
   * @param {{ purchase: object, event: object, items?: object[] }} data
   *   items: líneas de la compra { lotName, unitPrice, quantity }; sin ellas se usa la compra entera
   * @returns {Promise<{ gatewayId: string, checkoutUrl: string }>}
   */
  async createPayment({ purchase, event, items }) {
    const config = getConfig();
    const frontend = process.env.FRONTEND_URL || "http://localhost:5500";
    const returnUrl = `${frontend}/#/entradas/${purchase.accessToken}`;

    const payload = {
      external_reference: String(purchase.id),
      items: (items && items.length
        ? items
        : [{ lotName: purchase.lotName, unitPrice: purchase.totalPrice / purchase.quantity, quantity: purchase.quantity }]
      ).map((line) => ({
        title: [event.title, line.lotName].filter(Boolean).join(" - ").slice(0, 100),
        quantity: line.quantity,
        unit_price: Number(Number(line.unitPrice).toFixed(2)),
        currency_id: "ARS",
      })),
      payer: { name: purchase.buyerName, email: purchase.buyerEmail },
      back_urls: { success: returnUrl, pending: returnUrl, failure: returnUrl },
      expires: true,
      expiration_date_to: new Date(Date.now() + paymentWindowMinutes() * 60 * 1000).toISOString(),
    };
    // Mercado Pago solo acepta auto_return con back_urls https
    if (frontend.startsWith("https://")) payload.auto_return = "approved";
    // A dónde avisa Mercado Pago los pagos: tiene que ser una URL pública
    if (process.env.BACKEND_URL) {
      payload.notification_url = `${process.env.BACKEND_URL}/api/purchases/webhook`;
    }

    const data = await api(
      config,
      "/checkout/preferences",
      { method: "POST", body: JSON.stringify(payload) },
      "la creación de la preferencia de pago"
    );
    if (!data.init_point) throw new Error("Mercado Pago: la respuesta no incluye init_point");

    return { gatewayId: String(purchase.id), checkoutUrl: data.init_point };
  },

  /**
   * Interpretar un webhook de Mercado Pago. Del body/query solo se toma el id del
   * pago y el estado real se consulta a la API con el access token del comercio
   * @returns {Promise<{ gatewayId: string, status: string }|null>} null si no es válido
   */
  async resolveWebhook(req) {
    const config = getConfig();
    const paymentId = paymentIdFrom(req);
    if (!paymentId) return null;

    let payment;
    try {
      payment = await api(config, `/v1/payments/${paymentId}`, { method: "GET" }, "la consulta del pago");
    } catch (error) {
      // Un id inexistente es una notificación inválida (400); cualquier otro
      // error propaga para que Mercado Pago reintente el webhook
      if ([400, 404].includes(error.status)) return null;
      throw error;
    }

    const status = STATUS_MAP[payment.status];
    if (!payment.external_reference || !status) return null;

    return { gatewayId: String(payment.external_reference), status };
  },
};
