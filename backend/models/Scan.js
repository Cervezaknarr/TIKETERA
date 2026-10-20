const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/database");
const Event = require("./Event");
const Ticket = require("./Ticket");

// Registro de cada escaneo hecho por el staff (auditoría y detección de duplicados)
const Scan = sequelize.define("Scan", {
  // El id lo genera el dispositivo, así reenviar el mismo escaneo no lo duplica
  id: {
    type: DataTypes.UUID,
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
  ticketId: {
    type: DataTypes.UUID,
    allowNull: true, // null si el código no corresponde a ninguna entrada
    references: {
      model: Ticket,
      key: "id",
    },
  },
  code: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  deviceId: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  staffUserId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  // Hora en la que se escaneó en el dispositivo (puede ser antes de sincronizar)
  scannedAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  result: {
    type: DataTypes.ENUM("admitted", "duplicate", "invalid", "void"),
    allowNull: false,
  },
});

Event.hasMany(Scan, { foreignKey: "eventId" });
Scan.belongsTo(Event, { foreignKey: "eventId" });
Ticket.hasMany(Scan, { foreignKey: "ticketId" });
Scan.belongsTo(Ticket, { foreignKey: "ticketId" });

module.exports = Scan;
