const { UniqueConstraintError, ValidationError } = require("sequelize");
const User = require("../models/User");

const MIN_PASSWORD_LENGTH = 8;

/**
 * Formato de usuario que se devuelve (nunca la contraseña)
 */
const serializeUser = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  createdAt: user.createdAt,
});

/**
 * Buscar un usuario staff por id. Los admin no se modifican desde la API:
 * así un admin no puede borrar o cambiar la contraseña de otro
 * @returns {Promise<User|null>}
 */
const findStaff = (id) => User.findOne({ where: { id, role: "staff" } });

const validatePassword = (password) =>
  typeof password === "string" && password.length >= MIN_PASSWORD_LENGTH;

/**
 * @desc    Listar el personal (staff y admins)
 * @route   GET /api/users
 * @access  Admin
 */
const getUsers = async (req, res) => {
  try {
    const users = await User.findAll({
      where: { role: ["staff", "admin"] },
      order: [
        ["role", "ASC"],
        ["name", "ASC"],
      ],
    });
    res.json({ success: true, users: users.map(serializeUser) });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Error al obtener los usuarios",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

/**
 * @desc    Crear un usuario staff (control de acceso)
 * @route   POST /api/users
 * @access  Admin
 * @body    { name, email, password }
 */
const createStaffUser = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "Nombre, email y contraseña son obligatorios",
      });
    }

    if (!validatePassword(password)) {
      return res.status(400).json({
        success: false,
        message: `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`,
      });
    }

    const user = await User.create({
      name: String(name).trim(),
      email: String(email).trim().toLowerCase(),
      password,
      role: "staff",
    });

    res.status(201).json({ success: true, user: serializeUser(user) });
  } catch (error) {
    if (error instanceof UniqueConstraintError) {
      return res.status(400).json({
        success: false,
        message: "Ya existe un usuario con ese email",
      });
    }
    if (error instanceof ValidationError) {
      return res.status(400).json({
        success: false,
        message: "El email no es válido",
      });
    }
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Error al crear el usuario",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

/**
 * @desc    Modificar un usuario staff (nombre o contraseña)
 * @route   PUT /api/users/:id
 * @access  Admin
 * @body    { name?, password? }
 */
const updateStaffUser = async (req, res) => {
  try {
    const user = await findStaff(req.params.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Usuario staff no encontrado",
      });
    }

    const { name, password } = req.body;

    if (password !== undefined && !validatePassword(password)) {
      return res.status(400).json({
        success: false,
        message: `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`,
      });
    }

    if (name) user.name = String(name).trim();
    if (password) user.password = password; // Se hashea en el hook beforeUpdate
    await user.save();

    res.json({ success: true, user: serializeUser(user) });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Error al modificar el usuario",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

/**
 * @desc    Borrar un usuario staff. Su sesión deja de funcionar en el acto
 *          (el middleware busca al usuario en cada request)
 * @route   DELETE /api/users/:id
 * @access  Admin
 */
const deleteStaffUser = async (req, res) => {
  try {
    const user = await findStaff(req.params.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Usuario staff no encontrado",
      });
    }

    // Los escaneos guardan staffUserId como dato de auditoría, sin clave
    // foránea, así que el historial de ingresos no se pierde
    await user.destroy();

    res.json({ success: true, message: "Usuario eliminado" });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Error al eliminar el usuario",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

module.exports = {
  MIN_PASSWORD_LENGTH,
  getUsers,
  createStaffUser,
  updateStaffUser,
  deleteStaffUser,
};
