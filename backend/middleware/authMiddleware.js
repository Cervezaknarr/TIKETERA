const jwt = require("jsonwebtoken");
const User = require("../models/User");
require("dotenv").config();

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
 * Middleware que verifica si el usuario es staff de control de acceso o administrador
 * Debe usarse después del middleware protect
 */
const staff = (req, res, next) => {
  if (req.user && (req.user.role === "staff" || req.user.role === "admin")) {
    next();
  } else {
    res.status(403).json({
      success: false,
      message: "No tienes permisos para realizar esta acción",
    });
  }
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
      req.isAdmin = !!user && user.role === "admin";
    }
  } catch (error) {
    // Token inválido o vencido: se trata como visitante
  }
  next();
};

module.exports = { protect, admin, staff, optionalAdmin };
