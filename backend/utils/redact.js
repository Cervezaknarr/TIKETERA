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

module.exports = { maskEmail };
