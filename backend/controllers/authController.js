const User = require("../models/User");
const jwt = require("jsonwebtoken");
const { audit } = require("../utils/audit");
const { maskEmail } = require("../utils/redact");
require("dotenv").config();

// Roles que pueden iniciar sesión
const STAFF_ROLES = ["staff", "organizer", "admin"];

/**
 * Generar un token JWT
 * @param {User} user
 * @returns {string} Token JWT
 */
const generateToken = (user) => {
  return jwt.sign({ id: user.id, v: user.tokenVersion }, process.env.JWT_SECRET, {
    // Alcanza para que el staff entre el día anterior y no le venza en la puerta
    expiresIn: process.env.JWT_EXPIRES_IN || "3d",
  });
};

/**
 * @desc    Autenticar usuario y generar token
 * @route   POST /api/auth/login
 * @access  Public
 */
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Verificar que se proporcionaron todos los campos
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Por favor proporciona correo electrónico y contraseña",
      });
    }

    // Buscar usuario por email
    const user = await User.findOne({ where: { email } });

    // Verificar si el usuario existe y la contraseña es correcta
    if (user && (await user.comparePassword(password))) {
      // Solo el personal tiene cuenta. Las cuentas "user" que quedaron del
      // registro anterior no tienen ningún permiso
      if (!STAFF_ROLES.includes(user.role)) {
        await audit(req, {
          action: "LOGIN_FAIL",
          entityType: "User",
          entityId: user.id,
          result: "denied",
          actor: { id: user.id, role: user.role },
          details: { reason: "no_role", email: maskEmail(email) },
        });
        return res.status(403).json({
          success: false,
          message: "Esta cuenta no tiene acceso. Pedile a un administrador que te habilite",
        });
      }

      await audit(req, {
        action: "LOGIN_OK",
        entityType: "User",
        entityId: user.id,
        actor: { id: user.id, role: user.role },
      });
      res.json({
        success: true,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
        },
        token: generateToken(user),
      });
    } else {
      await audit(req, {
        action: "LOGIN_FAIL",
        entityType: "User",
        entityId: user ? user.id : null,
        result: "failure",
        actor: user ? { id: user.id, role: user.role } : null,
        details: { reason: "bad_credentials", email: maskEmail(email) },
      });
      res.status(401).json({
        success: false,
        message: "Correo electrónico o contraseña incorrectos",
      });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Error al iniciar sesión",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

/**
 * @desc    Obtener perfil del usuario
 * @route   GET /api/auth/profile
 * @access  Private
 */
const getUserProfile = async (req, res) => {
  try {
    // req.user viene del middleware de protección
    const user = await User.findByPk(req.user.id, {
      attributes: { exclude: ["password"] }, // Excluir la contraseña del resultado
    });

    if (user) {
      res.json({
        success: true,
        user,
      });
    } else {
      res.status(404).json({
        success: false,
        message: "Usuario no encontrado",
      });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Error al obtener el perfil del usuario",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

module.exports = {
  login,
  getUserProfile,
};
