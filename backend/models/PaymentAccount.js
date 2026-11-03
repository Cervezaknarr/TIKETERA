const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/database");

// Cuenta de Mercado Pago con la que se cobra. Hay una sola activa a la vez: las
// compras nuevas se crean con ella, y cada compra recuerda su cuenta para
// confirmar el pago aunque después se cambie la activa
const PaymentAccount = sequelize.define("PaymentAccount", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  name: {
    type: DataTypes.STRING(60),
    allowNull: false,
  },
  // Access token cifrado (utils/secrets.js): nunca se guarda ni se devuelve en claro
  accessToken: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  // Últimos caracteres del token, para reconocer la cuenta en el panel
  tokenHint: {
    type: DataTypes.STRING(8),
    allowNull: false,
  },
  active: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
});

module.exports = PaymentAccount;
