const rateLimit = require("express-rate-limit");

/**
 * Limitador de pedidos por IP. Con `max` en 0 no limita (interruptor rápido por si
 * un límite mal calibrado bloquea compradores reales)
 * @param {{ windowMs: number, max: number, message: string }} options
 */
const createRateLimiter = ({ windowMs, max, message }) => {
  if (!max || max < 1) return (req, res, next) => next();

  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message },
  });
};

// En los tests no se limita (todos los pedidos salen de la misma IP). Los demás
// entornos usan estos valores, que se ajustan con variables de entorno
const fromEnv = (name, fallback) => {
  if (process.env.NODE_ENV === "test" && process.env[name] === undefined) return 0;
  return process.env[name] === undefined ? fallback : Number(process.env[name]);
};

// Compras por IP. Es un respaldo contra bots: es holgado a propósito porque varias
// personas pueden compartir IP (datos móviles, oficinas)
const checkoutLimiter = () =>
  createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: fromEnv("RATE_LIMIT_CHECKOUT_MAX", 60),
    message: "Demasiados intentos de compra desde tu conexión. Esperá unos minutos e intentá de nuevo",
  });

// Ingreso y registro: frena el adivinado de contraseñas
const authLimiter = () =>
  createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: fromEnv("RATE_LIMIT_AUTH_MAX", 30),
    message: "Demasiados intentos. Esperá unos minutos e intentá de nuevo",
  });

module.exports = { createRateLimiter, checkoutLimiter, authLimiter };
