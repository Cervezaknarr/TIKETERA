const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/database");

// Asignación de un staff a un evento. Un staff solo escanea los eventos donde está
// asignado, y puede estar en varios (una fila por evento). Sin claves foráneas a
// propósito, igual que Scan.staffUserId: las filas se limpian al borrar el usuario o el evento
const StaffEvent = sequelize.define(
  "StaffEvent",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false },
    eventId: { type: DataTypes.UUID, allowNull: false },
  },
  { indexes: [{ unique: true, fields: ["userId", "eventId"] }, { fields: ["eventId"] }] }
);

module.exports = StaffEvent;
