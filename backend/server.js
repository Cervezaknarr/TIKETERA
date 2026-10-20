const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { sequelize, testConnection } = require('./config/database');

// Importar rutas
const authRoutes = require("./routes/authRoutes");
const eventRoutes = require("./routes/eventRoutes");
const purchaseRoutes = require("./routes/purchaseRoutes");
const checkinRoutes = require("./routes/checkinRoutes");

// Inicializar Express
const app = express();

// Middlewares
app.use(cors()); // Habilitar CORS para todas las solicitudes
app.use(express.json()); // Parsear solicitudes con JSON
app.use(express.urlencoded({ extended: true })); // Parsear solicitudes con formularios

// Middleware para registrar solicitudes (útil para desarrollo)
if (process.env.NODE_ENV !== "production") {
  app.use((req, res, next) => {
    console.log(`${req.method} ${req.url}`);
    next();
  });
}

// Configurar rutas
app.use("/api/auth", authRoutes);
app.use("/api/events", eventRoutes);
app.use("/api/purchases", purchaseRoutes);
app.use("/api/checkin", checkinRoutes);

// Ruta de bienvenida / health check
app.get("/", (req, res) => {
  res.json({
    message: "API de Ticketera funcionando correctamente",
    environment: process.env.NODE_ENV || "development",
    timestamp: new Date().toISOString(),
  });
});

// Middleware para manejar rutas no encontradas
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Recurso no encontrado",
  });
});

// Middleware para manejar errores generales
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    message: "Error interno del servidor",
    error: process.env.NODE_ENV === "development" ? err.message : undefined,
  });
});

// Puerto
const PORT = process.env.PORT || 5000;

// Iniciar servidor
const startServer = async () => {
  try {
    // Verificar la conexión a la base de datos
    await testConnection();

    // Sincronizar modelos con la base de datos
    // En producción, probablemente quieras usar migraciones en lugar de sync
    // Para desarrollo, puedes usar { force: true } para recrear las tablas
    await sequelize.sync({ alter: true });
    console.log("Base de datos sincronizada correctamente");

    // Iniciar servidor
    app.listen(PORT, () => {
      console.log(`Servidor corriendo en puerto ${PORT}`);
    });
  } catch (error) {
    console.error("Error al iniciar el servidor:", error);
    process.exit(1);
  }
};

// Solo arrancar si se ejecuta directamente (los tests importan la app sin levantarla)
if (require.main === module) {
  startServer();
}

module.exports = app;
