const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Event = require("../models/Event");
require("dotenv").config();

// Los tokens anteriores a tokenVersion no traen `v`: valen como versión 0
const isCurrentToken = (decoded, user) => (decoded.v || 0) === user.tokenVersion;

/**
 * Middleware que verifica si el token JWT es válido
 * Si es válido, añade el userId al objeto req
 */
const protect = async (req, res, next) => {
  try {
    let token;

    // Verificar si hay token y si empieza con "Bearer"
    if (
      req.headers.authorization &&
      req.headers.authorization.startsWith("Bearer")
    ) {
      token = req.headers.authorization.split(" ")[1]; // Obtener el token sin "Bearer"
    }

    // Verificar que el token exista
    if (!token) {
      return res.status(401).json({
        success: false,
        message: "No estás autorizado para acceder a este recurso",
      });
    }

    try {
      // Verificar el token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Añadir el usuario al req
      req.user = await User.findByPk(decoded.id);

      // Si el usuario no existe
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: "El usuario perteneciente a este token ya no existe",
        });
      }

      // La contraseña cambió después de emitir el token
      if (!isCurrentToken(decoded, req.user)) {
        return res.status(401).json({
          success: false,
          message: "Token no válido o expirado",
        });
      }

      next();
    } catch (error) {
      return res.status(401).json({
        success: false,
        message: "Token no válido o expirado",
      });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Error en la autenticación",
    });
  }
};

/**
 * Middleware que verifica si el usuario es un administrador
 * Debe usarse después del middleware protect
 */
const admin = (req, res, next) => {
  if (req.user && req.user.role === "admin") {
    next();
  } else {
    res.status(403).json({
      success: false,
      message: "No tienes permisos para realizar esta acción",
    });
  }
};

/**
 * Middleware que verifica si el usuario es staff de control de acceso, organizador o
 * administrador (los tres pueden escanear; a qué eventos, lo decide scanAccess)
 * Debe usarse después del middleware protect
 */
const staff = (req, res, next) => {
  if (req.user && ["staff", "organizer", "admin"].includes(req.user.role)) {
    next();
  } else {
    res.status(403).json({
      success: false,
      message: "No tienes permisos para realizar esta acción",
    });
  }
};

const forbidden = (res) =>
  res.status(403).json({
    success: false,
    message: "No tienes permisos para realizar esta acción",
  });

/**
 * ¿Puede este usuario escanear entradas del evento? El admin y el staff general sí;
 * el organizador solo en sus eventos y el staff de un organizador, solo en el suyo
 */
const canScanEvent = (user, event) => {
  if (user.role === "admin") return true;
  if (user.role === "organizer") return event.organizerId === user.id;
  if (user.role === "staff") return !user.eventId || user.eventId === event.id;
  return false;
};

/**
 * Middleware para rutas con :eventId donde se escanea (check-in): responde 404 si el
 * evento no existe y 403 si el usuario no puede escanear ahí
 * Debe usarse después de protect y staff
 */
const scanAccess = async (req, res, next) => {
  try {
    const event = await Event.findByPk(req.params.eventId);
    if (!event) {
      return res.status(404).json({ success: false, message: "Evento no encontrado" });
    }
    if (!canScanEvent(req.user, event)) return forbidden(res);
    req.managedEvent = event;
    next();
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Error al verificar el acceso al evento" });
  }
};

/**
 * Middleware para rutas con :eventId que administra el dueño del evento: el admin, o
 * el organizador asignado a ESE evento. Deja el evento en req.managedEvent
 * Debe usarse después de protect
 */
const eventManager = async (req, res, next) => {
  try {
    if (!req.user || !["admin", "organizer"].includes(req.user.role)) return forbidden(res);
    const event = await Event.findByPk(req.params.eventId);
    if (!event) {
      return res.status(404).json({ success: false, message: "Evento no encontrado" });
    }
    if (req.user.role === "organizer" && event.organizerId !== req.user.id) return forbidden(res);
    req.managedEvent = event;
    next();
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Error al verificar el acceso al evento" });
  }
};

/**
 * Middleware que deja pasar solo a organizadores (y admins)
 * Debe usarse después del middleware protect
 */
const organizer = (req, res, next) => {
  if (req.user && ["organizer", "admin"].includes(req.user.role)) return next();
  forbidden(res);
};

/**
 * Middleware para rutas públicas que muestran más al administrador:
 * si llega un token válido de un admin marca req.isAdmin; si no, sigue como visitante
 */
const optionalAdmin = async (req, res, next) => {
  req.isAdmin = false;
  try {
    const header = req.headers.authorization;
    if (header && header.startsWith("Bearer")) {
      const decoded = jwt.verify(header.split(" ")[1], process.env.JWT_SECRET);
      const user = await User.findByPk(decoded.id);
      req.isAdmin = !!user && user.role === "admin" && isCurrentToken(decoded, user);
    }
  } catch (error) {
    // Token inválido o vencido: se trata como visitante
  }
  next();
};

module.exports = {
  protect,
  admin,
  staff,
  organizer,
  eventManager,
  scanAccess,
  canScanEvent,
  optionalAdmin,
};
