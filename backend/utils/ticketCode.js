const crypto = require("crypto");

// Alfabeto Crockford base32: sin I, L, O, U para evitar confusiones al tipear
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 10;

/**
 * Generar un código de entrada aleatorio (ej: "7KQ2M-X9D4F")
 * 10 caracteres base32 = 50 bits, imposible de adivinar
 * @returns {string} Código formateado en dos grupos de 5
 */
const generateTicketCode = () => {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }
  return `${code.slice(0, 5)}-${code.slice(5)}`;
};

/**
 * Normalizar un código ingresado a mano o escaneado
 * Acepta minúsculas, espacios, sin guión, y corrige O→0, I/L→1
 * @param {string} input - Código tal como lo ingresó el staff
 * @returns {string|null} Código en formato canónico o null si no es válido
 */
const normalizeTicketCode = (input) => {
  if (typeof input !== "string") return null;

  const clean = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");

  if (clean.length !== CODE_LENGTH) return null;
  for (const char of clean) {
    if (!ALPHABET.includes(char)) return null;
  }

  return `${clean.slice(0, 5)}-${clean.slice(5)}`;
};

module.exports = { generateTicketCode, normalizeTicketCode };
