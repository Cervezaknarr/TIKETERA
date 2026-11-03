const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/database");
const Event = require("./Event");
const Lot = require("./Lot");

// Un paquete es una promo del evento: "N entradas de un lote con X% de descuento".
// Se compra de a paquetes enteros (1 paquete = N entradas, cada una con su QR).
// Los paquetes son del evento y se configuran desde el panel del administrador
const Pack = sequelize.define("Pack", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  eventId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: Event, key: "id" },
  },
  lotId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: Lot, key: "id" },
  },
  // Entradas que trae el paquete (2 o más)
  quantity: {
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: { min: 2 },
  },
  // Descuento sobre el precio del lote, en porcentaje (0,01 a 90)
  discountPercent: {
    type: DataTypes.DECIMAL(5, 2),
    allowNull: false,
    validate: { min: 0.01, max: 90 },
  },
});

Event.hasMany(Pack, { foreignKey: "eventId" });
Pack.belongsTo(Event, { foreignKey: "eventId" });
Lot.hasMany(Pack, { foreignKey: "lotId" });
Pack.belongsTo(Lot, { foreignKey: "lotId" });

module.exports = Pack;
