const { Sequelize } = require('sequelize');
require('dotenv').config();

// Los tests usan DATABASE_URL=sqlite::memory: para no depender de un Postgres
const isSqlite = (process.env.DATABASE_URL || '').startsWith('sqlite:');

// Crear una nueva instancia de Sequelize
const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: isSqlite ? 'sqlite' : 'postgres',
  logging: false, // Establece en true para ver los logs SQL en la consola
  dialectOptions: isSqlite ? {} : {
    ssl: {
      require: process.env.NODE_ENV === 'production', // Habilitar SSL en producción
      rejectUnauthorized: false // Necesario para algunas plataformas de alojamiento
    }
  },
  pool: {
    max: 5, // Máximo número de conexiones en el pool
    min: 0, // Mínimo número de conexiones en el pool
    acquire: 30000, // Tiempo máximo, en milisegundos, que el pool intentará obtener una conexión antes de lanzar un error
    idle: 10000 // Tiempo máximo, en milisegundos, que una conexión puede estar inactiva antes de ser liberada
  }
});

// Función para verificar la conexión a la base de datos
const testConnection = async () => {
  try {
    await sequelize.authenticate();
    console.log('Conexión a la base de datos establecida correctamente.');
    return true;
  } catch (error) {
    console.error('Error al conectar con la base de datos:', error);
    return false;
  }
};

module.exports = {
  sequelize,
  testConnection
};
