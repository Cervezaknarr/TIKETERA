const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/database");
const Event = require("./Event");

// Un lote es un tipo de entrada del evento (EARLY, VIP, General, Jugador...) con
// su propio precio y cupo. Una compra es siempre de un solo lote
const Lot = sequelize.define("Lot", {
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
  name: {
    type: DataTypes.STRING(60),
    allowNull: false,
  },
  price: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    validate: { min: 0 },
  },
  // Cantidad asignada por el organizador (vendidas + reservadas + disponibles)
  quantity: {
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: { min: 0 },
  },
  // Lo que queda para vender. Se descuenta de forma atómica al reservar y se
  // devuelve si la compra vence o falla. 0 = agotada
  ticketsAvailable: {
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: { min: 0 },
  },
  // Con código, el lote no se muestra al público: solo lo ve y lo compra quien
  // tenga el código (en mayúsculas, ver utils/lots.js). null = lote público
  accessCode: {
    type: DataTypes.STRING(40),
    allowNull: true,
  },
  // Orden en que se muestran los lotes
  position: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
});

Event.hasMany(Lot, { foreignKey: "eventId" });
Lot.belongsTo(Event, { foreignKey: "eventId" });

module.exports = Lot;
