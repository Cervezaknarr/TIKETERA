const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/database");
const Event = require("./Event");
const Purchase = require("./Purchase");

// Una entrada = una persona. Una compra de N entradas genera N tickets
const Ticket = sequelize.define(
  "Ticket",
  {
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
    purchaseId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: Purchase,
        key: "id",
      },
    },
    // Código alfanumérico que va en el QR y se puede tipear (ej: "7KQ2M-X9D4F")
    code: {
      type: DataTypes.STRING(11),
      allowNull: false,
      unique: true,
    },
    // Lote de esta entrada: una compra puede mezclar varios lotes. Las entradas
    // anteriores a esto no lo tienen (se usa el lote de la compra)
    lotId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    lotName: {
      type: DataTypes.STRING(60),
      allowNull: true,
    },
    // Nombre del asistente (opcional, el comprador lo puede completar después)
    holderName: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM("valid", "used", "void"),
      defaultValue: "valid",
      allowNull: false,
    },
    usedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    // Dispositivo del staff que registró el ingreso
    usedByDevice: {
      type: DataTypes.STRING,
      allowNull: true,
    },
  },
  {
    // updatedAt se usa para la sincronización incremental de la app de staff
    indexes: [{ fields: ["eventId", "updatedAt"] }],
  }
);

Event.hasMany(Ticket, { foreignKey: "eventId" });
Ticket.belongsTo(Event, { foreignKey: "eventId" });
Purchase.hasMany(Ticket, { foreignKey: "purchaseId" });
Ticket.belongsTo(Purchase, { foreignKey: "purchaseId" });

module.exports = Ticket;
