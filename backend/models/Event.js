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
  // Organizador del evento (usuario con rol "organizer"): ve sus compradores, crea
  // su staff y maneja sus cobros. null = lo maneja solo el administrador
  organizerId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  // Pausa de ventas de este evento (la pausa general de la plataforma es aparte)
  salesPaused: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  // Cuenta de Mercado Pago con la que cobra este evento (una cuenta propia del
  // evento, ver PaymentAccount.eventId). null = la cuenta general de la plataforma
  paymentAccountId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  // Solo mayores de 18: muestra la etiqueta en el evento, no cambia la compra
  adultsOnly: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  // Edad mínima que se muestra en la etiqueta (+18, +21...). null = sin etiqueta.
  // Los eventos viejos tienen adultsOnly=true y minAge=null: se leen como +18.
  minAge: {
    type: DataTypes.INTEGER,
    allowNull: true,
    validate: { min: 1, max: 99 },
  },
  status: {
    type: DataTypes.ENUM("draft", "published", "cancelled"),
    defaultValue: "published",
  },
  // No listado: se vende igual, pero no aparece en el listado público; solo se entra con
  // su link (/e/<slug>). No es privado: quien conozca el link lo ve
  unlisted: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
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
