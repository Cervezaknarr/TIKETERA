const path = require('path');
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
// El frontend se sirve desde este mismo servidor, así que en producción no hace
// falta CORS. Se habilita solo si CORS_ORIGIN lista orígenes (separados por coma)
// o fuera de producción, para abrir el frontend desde otro puerto
if (process.env.CORS_ORIGIN) {
  app.use(cors({ origin: process.env.CORS_ORIGIN.split(",").map((o) => o.trim()) }));
} else if (process.env.NODE_ENV !== "production") {
  app.use(cors());
}
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

// Health check (lo usa el host para saber si el servidor está vivo)
app.get("/health", (req, res) => {
  res.json({
    message: "API de Ticketera funcionando correctamente",
    environment: process.env.NODE_ENV || "development",
    timestamp: new Date().toISOString(),
  });
});

// Frontend estático: la navegación es por hash (#/...), no hace falta fallback
app.use(express.static(path.join(__dirname, "..", "frontend")));

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
