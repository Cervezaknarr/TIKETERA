const User = require("../models/User");
const jwt = require("jsonwebtoken");
require("dotenv").config();

// Roles que pueden iniciar sesión
const STAFF_ROLES = ["staff", "admin"];

/**
 * Generar un token JWT
 * @param {string} id - ID del usuario
 * @returns {string} Token JWT
 */
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: "30d", // El token expira en 30 días
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
        return res.status(403).json({
          success: false,
          message: "Esta cuenta no tiene acceso. Pedile a un administrador que te habilite",
        });
      }

      res.json({
        success: true,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
        },
        token: generateToken(user.id),
      });
    } else {
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
