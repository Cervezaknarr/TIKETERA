const Lot = require("../models/Lot");

/**
 * Validar los datos de un lote que manda el organizador.
 * Con `partial` solo se validan los campos presentes (edición)
 * @returns {{ error?: string, data?: object }}
 */
const parseLotInput = (input, { partial = false } = {}) => {
  const data = {};
  const has = (key) => input[key] !== undefined && input[key] !== null;

  if (!partial || has("name")) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name || name.length > 60) {
      return { error: "El nombre del lote es obligatorio (hasta 60 caracteres)" };
    }
    data.name = name;
  }

  if (!partial || has("price")) {
    const price = Number(input.price);
    if (input.price === "" || !Number.isFinite(price) || price < 0) {
      return { error: "El precio del lote tiene que ser un número mayor o igual a 0" };
    }
    data.price = Math.round(price * 100) / 100;
  }

  if (!partial || has("quantity")) {
    if (!Number.isInteger(input.quantity) || input.quantity < (partial ? 0 : 1)) {
      return {
        error: partial
          ? "La cantidad del lote tiene que ser un número entero mayor o igual a 0"
          : "La cantidad del lote tiene que ser un número entero mayor a 0",
      };
    }
    data.quantity = input.quantity;
  }

  return { data };
};

/**
 * Traer los lotes de varios eventos y adjuntarlos, con el cupo total disponible.
 * Los lotes salen en el orden que definió el organizador
 */
const withLots = async (events) => {
  const list = Array.isArray(events) ? events : [events];
  const lots = await Lot.findAll({
    where: { eventId: list.map((e) => e.id) },
    order: [
      ["position", "ASC"],
      ["createdAt", "ASC"],
    ],
  });

  const result = list.map((event) => {
    const json = event.toJSON();
    // El precio y el cupo viven en los lotes (las columnas del evento están en desuso)
    delete json.ticketPrice;
    delete json.ticketsAvailable;
    json.lots = lots.filter((lot) => lot.eventId === event.id);
    json.ticketsAvailable = json.lots.reduce((sum, lot) => sum + lot.ticketsAvailable, 0);
    return json;
  });
  return Array.isArray(events) ? result : result[0];
};

module.exports = { parseLotInput, withLots };
