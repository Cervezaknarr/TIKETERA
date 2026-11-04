const User = require("../models/User");
const { MIN_PASSWORD_LENGTH } = require("../controllers/userController");
const { maskEmail } = require("./redact");

/**
 * Crear el primer admin a partir de ADMIN_EMAIL y ADMIN_PASSWORD (ADMIN_NAME opcional).
 * Se usa al arrancar porque en el plan gratis de Render no hay consola para
 * correr un script.
 * - Solo crea el admin si NO existe ningún admin y el email no está usado.
 * - Nunca asciende una cuenta existente (staff u organizador) ni cambia contraseñas:
 *   así dejar ADMIN_EMAIL en el entorno no es una puerta para ganar permisos.
 * Sin ADMIN_EMAIL no hace nada. Una vez creado, se pueden borrar las variables.
 */
const ensureAdmin = async () => {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) return;

  if (await User.count({ where: { role: "admin" } })) return;

  if (await User.findOne({ where: { email } })) {
    console.error(
      `ADMIN_EMAIL (${maskEmail(email)}) ya es una cuenta que no es admin: no se la asciende. Usá otro email para el primer admin`
    );
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
  console.log(`Admin ${maskEmail(email)} creado`);
};

module.exports = { ensureAdmin };
