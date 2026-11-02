const Lot = require("../models/Lot");

// Los códigos de acceso no distinguen mayúsculas ni espacios en los extremos
const normalizeCode = (code) => (typeof code === "string" ? code.trim().toUpperCase() : "");

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

  // Código de acceso opcional: vacío o null lo quita y el lote pasa a ser público
  if (input.accessCode !== undefined) {
    const code = normalizeCode(input.accessCode);
    if (input.accessCode !== null && typeof input.accessCode !== "string") {
      return { error: "El código del lote es inválido" };
    }
    if (code && !/^[A-Z0-9_-]{4,40}$/.test(code)) {
      return { error: "El código tiene que tener de 4 a 40 letras o números, sin espacios" };
    }
    data.accessCode = code || null;
  }

  return { data };
};

/**
 * Traer los lotes de varios eventos y adjuntarlos, con el cupo total disponible.
 * Los lotes salen en el orden que definió el organizador. El público no ve los
 * lotes con código, ni el código, ni su cupo: solo `hasCodeLots`, para saber si
 * hay que ofrecerle dónde ingresarlo
 */
const withLots = async (events, { isAdmin = false } = {}) => {
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
    const eventLots = lots.filter((lot) => lot.eventId === event.id);
    json.hasCodeLots = eventLots.some((lot) => lot.accessCode && lot.ticketsAvailable > 0);
    json.lots = isAdmin ? eventLots : eventLots.filter((lot) => !lot.accessCode);
    json.ticketsAvailable = json.lots.reduce((sum, lot) => sum + lot.ticketsAvailable, 0);
    return json;
  });
  return Array.isArray(events) ? result : result[0];
};

module.exports = { normalizeCode, parseLotInput, withLots };
