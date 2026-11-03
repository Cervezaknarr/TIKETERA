const crypto = require("crypto");

// Cifrado en reposo (AES-256-GCM) de los access tokens guardados en la base. La
// clave sale de PAYMENT_ACCOUNTS_KEY: si se pierde o cambia, los tokens guardados
// no se pueden leer y hay que volver a cargarlos
const key = () => {
  const secret = process.env.PAYMENT_ACCOUNTS_KEY;
  if (!secret) {
    throw new Error(
      "Falta PAYMENT_ACCOUNTS_KEY: es la clave con la que se cifran los tokens de las cuentas de pago"
    );
  }
  return crypto.createHash("sha256").update(secret).digest();
};

const encrypt = (text) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return ["v1", iv.toString("hex"), cipher.getAuthTag().toString("hex"), data.toString("hex")].join(":");
};

const decrypt = (payload) => {
  const [version, iv, tag, data] = String(payload).split(":");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("Token cifrado con formato inválido");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(data, "hex")), decipher.final()]).toString("utf8");
};

module.exports = { encrypt, decrypt };
