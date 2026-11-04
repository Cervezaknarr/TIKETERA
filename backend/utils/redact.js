/**
 * Enmascara un email para logs: "ana@dominio.com" -> "a***@dominio.com".
 * Tolera valores nulos o que no sean string.
 * @param {*} email
 * @returns {string}
 */
const maskEmail = (email) => {
  if (typeof email !== "string") return "(sin email)";
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
};

/**
 * Limpia texto libre que escribe una persona antes de guardarlo en la auditoría: los emails
 * pasan por maskEmail y toda secuencia de 7 o más dígitos (aunque lleve puntos, guiones o
 * espacios entre dígitos, como un DNI "30.123.456") se reemplaza por "***".
 * @param {string} text
 * @returns {string}
 */
const scrubFreeText = (text) =>
  String(text)
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, (email) => maskEmail(email))
    .replace(/\d(?:[\s.\-]*\d){6,}/g, "***");

module.exports = { maskEmail, scrubFreeText };
