const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/database");
const Purchase = require("./Purchase");

// Una línea de una compra: cuántas entradas de qué lote. Una compra puede llevar
// varios lotes (por ejemplo 2 Generales y 3 VIP) y se paga de una sola vez.
// Nombre y precio se guardan tal como estaban al comprar
const PurchaseItem = sequelize.define("PurchaseItem", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  purchaseId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: Purchase,
      key: "id",
    },
  },
  lotId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  lotName: {
    type: DataTypes.STRING(60),
    allowNull: false,
  },
  unitPrice: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
  },
  quantity: {
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: {
      min: 1,
    },
  },
});

Purchase.hasMany(PurchaseItem, { foreignKey: "purchaseId", as: "items" });
PurchaseItem.belongsTo(Purchase, { foreignKey: "purchaseId" });

module.exports = PurchaseItem;
