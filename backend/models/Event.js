const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/database");
const User = require("./User");

const Event = sequelize.define("Event", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  title: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  date: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  location: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  // En desuso: el precio y el cupo viven en los lotes (models/Lot.js). Las
  // columnas siguen para no romper la base existente y los eventos viejos se
  // migran a un lote "General" al arrancar (utils/migrateLots.js)
  ticketPrice: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true,
  },
  ticketsAvailable: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  userId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: User,
      key: "id",
    },
  },
  imageUrl: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  status: {
    type: DataTypes.ENUM("draft", "published", "cancelled"),
    defaultValue: "published",
  },
});

// Establecer relación: Un usuario puede crear muchos eventos
User.hasMany(Event, { foreignKey: "userId" });
Event.belongsTo(User, { foreignKey: "userId" });

module.exports = Event;
