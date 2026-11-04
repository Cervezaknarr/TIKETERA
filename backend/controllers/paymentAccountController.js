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
 * @desc    Cuentas de Mercado Pago, estado de las ventas y compras sin pagar
 * @route   GET /api/payment-accounts
 * @access  Admin
 */
const getPaymentAccounts = async (req, res) => {
  try {
    const accounts = await PaymentAccount.findAll({ where: { eventId: null }, order: [["createdAt", "ASC"]] });
    res.json({
      success: true,
      accounts: accounts.map(present),
      salesPaused: await isSalesPaused(),
      // Compras que todavía pueden recibir un aviso de pago
      pendingPurchases: await Purchase.count({ where: { status: "pending" } }),
      provider: process.env.PAYMENT_PROVIDER || "mock",
      envToken: Boolean(process.env.MERCADOPAGO_ACCESS_TOKEN),
      keyConfigured: Boolean(process.env.PAYMENT_ACCOUNTS_KEY),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Error al obtener las cuentas de pago" });
  }
};

/**
 * @desc    Agregar una cuenta (queda inactiva hasta que se active)
 * @route   POST /api/payment-accounts
 * @access  Admin (o el organizador del evento, desde /api/organizer)
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
    const account = await PaymentAccount.create({
      name,
      accessToken: encrypt(accessToken),
      tokenHint: accessToken.slice(-4),
      eventId: req.managedEvent ? req.managedEvent.id : null,
    });
    await audit(req, {
      action: "PAYMENT_ACCOUNT_CREATE",
      entityType: "PaymentAccount",
      entityId: account.id,
      eventId: account.eventId,
      details: { name: account.name },
    });
    res.status(201).json({ success: true, account: present(account) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Error al guardar la cuenta de pago" });
  }
};

/**
 * @desc    Dejar una cuenta como la activa. Con ventas pausadas: así nadie compra a
 *          mitad del cambio
 * @route   POST /api/payment-accounts/:id/activate
 * @access  Admin
 */
const activatePaymentAccount = async (req, res) => {
  try {
    if (!(await isSalesPaused())) {
      return res.status(409).json({
        success: false,
        message: "Pausá las ventas antes de cambiar la cuenta de cobro",
      });
    }

    let previousId = null;
    const result = await sequelize.transaction(async (transaction) => {
      // Solo cuentas generales: las que cargan los organizadores son de cada evento
      const account = await PaymentAccount.findOne({ where: { id: req.params.id, eventId: null }, transaction });
      if (!account) return null;
      const prev = await PaymentAccount.findOne({ where: { eventId: null, active: true }, transaction });
      previousId = prev ? prev.id : null;
      await PaymentAccount.update({ active: false }, { where: { eventId: null }, transaction });
      account.active = true;
      await account.save({ transaction });
      return account;
    });

    if (!result) {
      return res.status(404).json({ success: false, message: "Cuenta no encontrada" });
    }
    await audit(req, {
      action: "PAYMENT_ACCOUNT_ACTIVATE",
      entityType: "PaymentAccount",
      entityId: result.id,
      details: { activeAccountId: { from: previousId, to: result.id } },
    });
    res.json({ success: true, account: present(result) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Error al activar la cuenta" });
  }
};

/**
 * @desc    Borrar una cuenta que no está activa ni se usó en ninguna compra
 * @route   DELETE /api/payment-accounts/:id
 * @access  Admin
 */
const deletePaymentAccount = async (req, res) => {
  try {
    const account = await PaymentAccount.findOne({ where: { id: req.params.id, eventId: null } });
    if (!account) {
      return res.status(404).json({ success: false, message: "Cuenta no encontrada" });
    }
    if (account.active) {
      return res.status(409).json({ success: false, message: "No se puede borrar la cuenta activa" });
    }
    // Sus compras necesitan el token para confirmar los pagos
    if (await Purchase.count({ where: { paymentAccountId: account.id } })) {
      return res.status(409).json({
        success: false,
        message: "Esta cuenta ya cobró compras y su token hace falta para confirmar pagos",
      });
    }
    await account.destroy();
    await audit(req, {
      action: "PAYMENT_ACCOUNT_DELETE",
      entityType: "PaymentAccount",
      entityId: account.id,
      details: { name: account.name },
    });
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Error al borrar la cuenta" });
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
  getPaymentAccounts,
  createPaymentAccount,
  activatePaymentAccount,
  deletePaymentAccount,
  updateSalesPaused,
};
