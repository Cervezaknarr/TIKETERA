const PaymentAccount = require("../models/PaymentAccount");
const Purchase = require("../models/Purchase");
const { sequelize } = require("../config/database");
const { encrypt } = require("../utils/secrets");
const { isSalesPaused, setSalesPaused } = require("../utils/paymentAccounts");
const { request } = require("../utils/payments/http");
const { audit } = require("../utils/audit");

// Resumen de una cuenta para el panel: el token nunca sale del servidor
const present = (account) => ({
  id: account.id,
  name: account.name,
  active: account.active,
  tokenHint: account.tokenHint,
  createdAt: account.createdAt,
});

/**
 * @desc    Estado general de los cobros: pausa de ventas y compras sin pagar. Las cuentas de
 *          Mercado Pago son de cada evento (se manejan en /api/organizer/events/:id/payments)
 * @route   GET /api/payment-accounts
 * @access  Admin
 */
const getPaymentStatus = async (req, res) => {
  try {
    res.json({
      success: true,
      salesPaused: await isSalesPaused(),
      // Compras que todavía pueden recibir un aviso de pago
      pendingPurchases: await Purchase.count({ where: { status: "pending" } }),
      provider: process.env.PAYMENT_PROVIDER || "mock",
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Error al obtener el estado de los cobros" });
  }
};

/**
 * @desc    Agregar una cuenta (queda inactiva hasta que se active)
 * @route   POST /api/organizer/events/:eventId/payments/accounts
 * @access  Admin u organizador del evento
 * @body    { name, accessToken }
 */
const createPaymentAccount = async (req, res) => {
  try {
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    const accessToken = typeof req.body.accessToken === "string" ? req.body.accessToken.trim() : "";

    if (!name || name.length > 60) {
      return res.status(400).json({ success: false, message: "Poné un nombre de hasta 60 caracteres" });
    }
    if (accessToken.length < 20 || accessToken.length > 300 || /\s/.test(accessToken)) {
      return res.status(400).json({ success: false, message: "El access token no es válido" });
    }
    if (!process.env.PAYMENT_ACCOUNTS_KEY) {
      return res.status(500).json({
        success: false,
        message: "Falta configurar PAYMENT_ACCOUNTS_KEY en el servidor para guardar cuentas",
      });
    }

    // Mercado Pago confirma que el token sirve antes de guardarlo (evita errores de tipeo)
    try {
      await request(
        "https://api.mercadopago.com/users/me",
        { method: "GET", headers: { Authorization: `Bearer ${accessToken}` } },
        "Mercado Pago: la verificación del token"
      );
    } catch (error) {
      if ([400, 401, 403].includes(error.status)) {
        return res.status(400).json({
          success: false,
          message: "Mercado Pago no aceptó ese access token. Revisá que sea el de producción de la cuenta",
        });
      }
      throw error;
    }

    // Desde el panel del organizador (eventManager) la cuenta queda como propia de ese
    // evento; desde el panel general del admin, como cuenta de la plataforma
    // Cuenta y auditoría en una transacción: si no se puede auditar, la cuenta no se crea
    const account = await sequelize.transaction(async (transaction) => {
      const created = await PaymentAccount.create(
        {
          name,
          accessToken: encrypt(accessToken),
          tokenHint: accessToken.slice(-4),
          eventId: req.managedEvent ? req.managedEvent.id : null,
        },
        { transaction }
      );
      await audit(req, {
        action: "PAYMENT_ACCOUNT_CREATE",
        entityType: "PaymentAccount",
        entityId: created.id,
        eventId: created.eventId,
        details: { name: created.name },
        transaction,
        strict: true,
      });
      return created;
    });
    res.status(201).json({ success: true, account: present(account) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Error al guardar la cuenta de pago" });
  }
};

/**
 * @desc    Pausar o reanudar las ventas
 * @route   PUT /api/payment-accounts/sales-paused
 * @access  Admin
 * @body    { paused: boolean }
 */
const updateSalesPaused = async (req, res) => {
  try {
    if (typeof req.body.paused !== "boolean") {
      return res.status(400).json({ success: false, message: "Indicá si las ventas están pausadas" });
    }
    const before = await isSalesPaused();
    await setSalesPaused(req.body.paused);
    await audit(req, {
      action: req.body.paused ? "SALES_PAUSE" : "SALES_RESUME",
      entityType: "Setting",
      entityId: "salesPaused",
      details: { salesPaused: { from: before, to: req.body.paused } },
    });
    res.json({ success: true, salesPaused: req.body.paused });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Error al cambiar el estado de las ventas" });
  }
};

module.exports = {
  present,
  getPaymentStatus,
  createPaymentAccount,
  updateSalesPaused,
};
