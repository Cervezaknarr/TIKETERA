const path = require('path');
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { sequelize, testConnection } = require('./config/database');
const { startExpirationSweep } = require('./utils/purchases');
const { migrateEventsToLots } = require('./utils/migrateLots');
const { checkoutLimiter, authLimiter } = require('./middleware/rateLimit');
const { ensureAdmin } = require('./utils/admin');

// Importar rutas
const authRoutes = require("./routes/authRoutes");
const eventRoutes = require("./routes/eventRoutes");
const purchaseRoutes = require("./routes/purchaseRoutes");
const checkinRoutes = require("./routes/checkinRoutes");
const userRoutes = require("./routes/userRoutes");

// Inicializar Express
const app = express();

// Middlewares
// Detrás del proxy del host (Render) la IP real del cliente viene en
// X-Forwarded-For. Sin esto, los límites por IP verían a todos como una sola IP.
// TRUST_PROXY = cantidad de proxies delante del servidor (0 para desactivarlo)
const trustProxy = process.env.TRUST_PROXY;
if (trustProxy !== undefined) app.set("trust proxy", Number(trustProxy));
else if (process.env.NODE_ENV === "production") app.set("trust proxy", 1);

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
// Límites por IP. El webhook de pago NO se limita: llega desde la pasarela
app.use("/api/auth", authLimiter(), authRoutes);
app.use("/api/events", eventRoutes);
app.use("/api/purchases/checkout", checkoutLimiter());
app.use("/api/purchases", purchaseRoutes);
app.use("/api/checkin", checkinRoutes);
app.use("/api/users", userRoutes);

// Health check (lo usa el host para saber si el servidor está vivo)
app.get("/health", (req, res) => {
  res.json({
    message: "API de Ticketera funcionando correctamente",
    environment: process.env.NODE_ENV || "development",
    timestamp: new Date().toISOString(),
  });
});

// Frontend estático: la navegación es por hash (#/...), no hace falta fallback.
// Tres sitios: / (visitantes: comprar y ver entradas), /staff (escáner) y /admin
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

    // Sincronizar modelos con la base de datos. `alter` modifica las tablas
    // existentes para que coincidan con los modelos: es lo que crea los lotes en una
    // base vieja, pero en Postgres repetirlo en cada arranque es riesgoso (puede
    // duplicar índices). Tras desplegar un cambio de modelos, poné
    // DB_SYNC_ALTER=false para que los reinicios solo creen las tablas faltantes
    await sequelize.sync({ alter: process.env.DB_SYNC_ALTER !== "false" });
    console.log("Base de datos sincronizada correctamente");

    // Eventos anteriores a los lotes: pasan a tener un lote "General"
    const migrated = await migrateEventsToLots();
    if (migrated) console.log(`Eventos migrados a lotes: ${migrated}`);

    // Crear el primer admin si está configurado ADMIN_EMAIL
    await ensureAdmin();

    // Iniciar servidor
    app.listen(PORT, () => {
      console.log(`Servidor corriendo en puerto ${PORT}`);
    });

    // Devolver al evento el cupo de las compras que nunca se pagaron
    startExpirationSweep();
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
