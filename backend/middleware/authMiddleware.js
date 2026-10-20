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

module.exports = { protect, admin, staff };
