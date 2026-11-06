const PaymentAccount = require("../models/PaymentAccount");
const Setting = require("../models/Setting");
const { decrypt } = require("./secrets");

const SALES_PAUSED = "salesPaused";

// Con las ventas pausadas el checkout no acepta compras nuevas; los avisos de pago
// y las entradas ya emitidas siguen funcionando
const isSalesPaused = async () => (await Setting.findByPk(SALES_PAUSED))?.value === "true";

const setSalesPaused = (paused) =>
  Setting.upsert({ key: SALES_PAUSED, value: paused ? "true" : "false" });

// Access token en claro de una cuenta, o null si no existe
const tokenOfAccount = async (id) => {
  const account = await PaymentAccount.findByPk(id);
  return account ? decrypt(account.accessToken) : null;
};

module.exports = { isSalesPaused, setSalesPaused, tokenOfAccount };
