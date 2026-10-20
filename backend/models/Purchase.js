const crypto = require("crypto");
const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/database");
const Event = require("./Event");

const Purchase = sequelize.define("Purchase", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  eventId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: Event,
      key: "id",
    },
  },
  buyerEmail: {
    type: DataTypes.STRING,
    allowNull: false,
    validate: {
      isEmail: true,
    },
  },
  buyerName: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  quantity: {
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: {
      min: 1,
    },
  },
  totalPrice: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
  },
  status: {
    type: DataTypes.ENUM("pending", "completed", "failed", "refunded"),
    defaultValue: "pending",
  },
  paymentGatewayId: {
    type: DataTypes.STRING,
    allowNull: true, // Será null hasta que se inicie el proceso de pago
  },
  purchaseDate: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
  // Token privado para el link "ver mis entradas" (no requiere cuenta)
  accessToken: {
    type: DataTypes.STRING(64),
    allowNull: false,
    unique: true,
    defaultValue: () => crypto.randomBytes(24).toString("hex"),
  },
});

// Establecer relación: Un evento puede tener muchas compras
Event.hasMany(Purchase, { foreignKey: "eventId" });
Purchase.belongsTo(Event, { foreignKey: "eventId" });

module.exports = Purchase;
