const User = require("../models/User");
const { MIN_PASSWORD_LENGTH } = require("../controllers/userController");

/**
 * Crear el primer admin a partir de ADMIN_EMAIL y ADMIN_PASSWORD (ADMIN_NAME opcional).
 * Se usa al arrancar porque en el plan gratis de Render no hay consola para
 * correr un script.
 * - Si no existe un usuario con ese email, lo crea como admin.
 * - Si existe, lo pasa a admin pero NO le cambia la contraseña: la variable
 *   solo sirve para la primera vez y después se puede borrar del panel.
 * Sin ADMIN_EMAIL no hace nada.
 */
const ensureAdmin = async () => {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) return;

  const existing = await User.findOne({ where: { email } });
  if (existing) {
    if (existing.role !== "admin") {
      await existing.update({ role: "admin" });
      console.log(`Usuario ${email} pasado a admin`);
    }
    return;
  }

  const password = process.env.ADMIN_PASSWORD;
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    console.error(
      `ADMIN_EMAIL está configurado pero ADMIN_PASSWORD falta o tiene menos de ${MIN_PASSWORD_LENGTH} caracteres: no se creó el admin`
    );
    return;
  }

  await User.create({
    name: process.env.ADMIN_NAME || "Administrador",
    email,
    password,
    role: "admin",
  });
  console.log(`Admin ${email} creado`);
};

module.exports = { ensureAdmin };
