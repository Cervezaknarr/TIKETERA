const Pack = require("../models/Pack");

const maxPerPurchase = () => Number(process.env.MAX_TICKETS_PER_PURCHASE) || 10;

/**
 * Precio de una entrada dentro de un paquete: el del lote menos el descuento,
 * redondeado a centavos. El frontend usa la misma fórmula para mostrarlo
 */
const packUnitPrice = (price, discountPercent) =>
  Math.round(Number(price) * (100 - Number(discountPercent))) / 100;

/**
 * Validar los datos de un paquete que manda el organizador.
 * Con `partial` solo se validan los campos presentes (edición)
 * @returns {{ error?: string, data?: object }}
 */
const parsePackInput = (input, { partial = false } = {}) => {
  const data = {};
  const has = (key) => input[key] !== undefined && input[key] !== null;

  if (!partial || has("lotId")) {
    if (typeof input.lotId !== "string" || !input.lotId) {
      return { error: "Elegí el tipo de entrada del paquete" };
    }
    data.lotId = input.lotId;
  }

  if (!partial || has("quantity")) {
    const max = maxPerPurchase();
    if (!Number.isInteger(input.quantity) || input.quantity < 2 || input.quantity > max) {
      return { error: `La cantidad del paquete tiene que ser un número entero entre 2 y ${max}` };
    }
    data.quantity = input.quantity;
  }

  if (!partial || has("discountPercent")) {
    const pct = Number(input.discountPercent);
    if (input.discountPercent === "" || !Number.isFinite(pct) || pct < 0.01 || pct > 90) {
      return { error: "El descuento tiene que ser un porcentaje entre 0,01 y 90" };
    }
    data.discountPercent = Math.round(pct * 100) / 100;
  }

  return { data };
};

/**
 * Paquetes de varios eventos, agrupados por evento y ordenados por lote y cantidad
 * @returns {Promise<Map<string, object[]>>} eventId -> paquetes
 */
const packsByEvent = async (eventIds) => {
  const packs = await Pack.findAll({
    where: { eventId: eventIds },
    order: [["quantity", "ASC"], ["createdAt", "ASC"]],
  });
  const map = new Map();
  for (const pack of packs) {
    const json = pack.toJSON();
    json.discountPercent = Number(json.discountPercent);
    map.set(pack.eventId, [...(map.get(pack.eventId) || []), json]);
  }
  return map;
};

module.exports = { parsePackInput, packUnitPrice, packsByEvent, maxPerPurchase };
