const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/database");
const User = require("./User");
const { uniqueSlug } = require("../utils/slug");

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
  // Parte final de la URL pública del evento: /e/<slug>
  slug: {
    type: DataTypes.STRING,
    allowNull: true,
    unique: true,
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
  // Portada: una URL o una imagen en data URL (la reduce el panel antes de subirla)
  imageUrl: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  status: {
    type: DataTypes.ENUM("draft", "published", "cancelled"),
    defaultValue: "published",
  },
});

Event.beforeCreate(async (event, options) => {
  if (!event.slug) {
    event.slug = await uniqueSlug(Event, event.title, null, options.transaction);
  }
});

// Establecer relación: Un usuario puede crear muchos eventos
User.hasMany(Event, { foreignKey: "userId" });
Event.belongsTo(User, { foreignKey: "userId" });

module.exports = Event;
