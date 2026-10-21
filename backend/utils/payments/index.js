// Cada pasarela implementa:
//   createPayment({ purchase, event }) -> { gatewayId, checkoutUrl|null }
//   resolveWebhook(req) -> { gatewayId, status: "approved"|"rejected"|"pending" } | null
// resolveWebhook debe verificar la autenticidad: el estado nunca se toma del
// body sin confirmarlo con la pasarela
const providers = {
  mock: () => require("./mock"),
  nave: () => require("./nave"),
  mercadopago: () => require("./mercadopago"),
};

let override = null;

/**
 * Pasarela activa, según PAYMENT_PROVIDER (por defecto "mock")
 */
const getProvider = () => {
  if (override) return override;

  const name = process.env.PAYMENT_PROVIDER || "mock";
  if (!providers[name]) {
    throw new Error(
      `PAYMENT_PROVIDER inválido: "${name}". Opciones: ${Object.keys(providers).join(", ")}`
    );
  }
  return providers[name]();
};

// Solo para tests: reemplaza la pasarela (null para volver a la configurada)
const setProvider = (provider) => {
  override = provider;
};

module.exports = { getProvider, setProvider };
