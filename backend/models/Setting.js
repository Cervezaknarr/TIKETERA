const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/database");

// Ajustes de la plataforma que el admin cambia sin redesplegar (clave -> valor)
const Setting = sequelize.define("Setting", {
  key: {
    type: DataTypes.STRING(60),
    primaryKey: true,
  },
  value: {
    type: DataTypes.STRING,
    allowNull: false,
  },
});

module.exports = Setting;
