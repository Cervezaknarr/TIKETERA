/**
 * Tandas de entradas secuenciales (PLAN.md > T-3). Funciones puras, sin base de datos.
 * Cada lote tiene dos modos: `afterPrevious = false` (a la vez, comportamiento normal) o
 * `afterPrevious = true` (se activa después de que se agote el lote anterior).
 * Una «cadena» empieza en un lote con afterPrevious=false y la forman los lotes consecutivos
 * siguientes con afterPrevious=true. Un lote encadenado está bloqueado si algún lote anterior de
 * su cadena (cabeza incluida) todavía tiene cupo. Los lotes con afterPrevious=false nunca se bloquean.
 */

const time = (value) => {
  const t = value ? new Date(value).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
};
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * @param {Array<{id, eventId, afterPrevious, position, createdAt, ticketsAvailable}>} lots
 * @returns {Set} ids de los lotes bloqueados (todavía no a la venta)
 */
const lockedLotIds = (lots) => {
  const locked = new Set();
  const byEvent = new Map();
  for (const lot of lots || []) {
    const key = lot.eventId ?? null;
    if (!byEvent.has(key)) byEvent.set(key, []);
    byEvent.get(key).push(lot);
  }
  for (const list of byEvent.values()) {
    list.sort(
      (a, b) =>
        cmp(a.position ?? 0, b.position ?? 0) ||
        cmp(time(a.createdAt), time(b.createdAt)) ||
        cmp(String(a.id), String(b.id))
    );
    let open = false; // algún lote anterior de la cadena actual tiene cupo
    list.forEach((lot, i) => {
      if (lot.afterPrevious !== true || i === 0) {
        // Cabeza de cadena (el primer lote del evento siempre lo es): nunca bloqueada
        open = lot.ticketsAvailable > 0;
        return;
      }
      if (open) locked.add(lot.id);
      else if (lot.ticketsAvailable > 0) open = true;
    });
  }
  return locked;
};

module.exports = { lockedLotIds };
