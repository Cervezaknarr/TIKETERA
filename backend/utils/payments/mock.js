const { v4: uuidv4 } = require("uuid");

// Pasarela simulada para desarrollo: el "pago" lo aprueba el propio frontend
// llamando al webhook. Nunca debe usarse en producción
const assertNotProduction = () => {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "PAYMENT_PROVIDER=mock no está permitido en producción: configurá una pasarela real"
    );
  }
};

module.exports = {
  name: "mock",

  async createPayment() {
    assertNotProduction();
    // Sin checkoutUrl: el frontend simula la aprobación del pago
    return { gatewayId: `mock_${uuidv4()}`, checkoutUrl: null };
  },

  async resolveWebhook(req) {
    assertNotProduction();
    const { paymentGatewayId, status } = req.body;
    if (!paymentGatewayId || !["approved", "rejected", "pending"].includes(status)) {
      return null;
    }
    return { gatewayId: paymentGatewayId, status };
  },
};
