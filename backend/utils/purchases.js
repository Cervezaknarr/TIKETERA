const { Op } = require("sequelize");
const Lot = require("../models/Lot");
const Purchase = require("../models/Purchase");
const PurchaseItem = require("../models/PurchaseItem");
const { sequelize } = require("../config/database");

const { holdMinutes } = require("./paymentWindow");

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Líneas de una compra: { lotId, lotName, unitPrice, quantity }. Las compras
 * anteriores a los carritos no tienen líneas: su lote vive en la propia compra
 * (y las muy viejas, sin lote, devuelven una lista vacía)
 */
const itemsOf = async (purchase, transaction) => {
  const items = await PurchaseItem.findAll({
    where: { purchaseId: purchase.id },
    order: [["lotName", "ASC"]],
    transaction,
  });
  if (items.length) return items;
  if (!purchase.lotId) return [];
  return [
    {
      lotId: purchase.lotId,
      lotName: purchase.lotName,
      unitPrice: purchase.unitPrice,
      quantity: purchase.quantity,
    },
  ];
};

/**
 * Devolver las entradas de una compra al cupo de sus lotes
 */
const releaseStock = async (purchase, transaction) => {
  for (const item of await itemsOf(purchase, transaction)) {
    await Lot.increment("ticketsAvailable", {
      by: item.quantity,
      where: { id: item.lotId },
      transaction,
    });
  }
};

/**
 * Descuento atómico: solo se aplica si todavía quedan entradas en el lote, así
 * dos compras simultáneas de las últimas entradas no pueden vender de más
 * (quantity es un entero validado, es seguro interpolarlo)
 * @returns {Promise<boolean>} true si se pudo reservar el cupo
 */
const reserveStock = async (lotId, quantity, transaction) => {
  const [reserved] = await Lot.update(
    { ticketsAvailable: sequelize.literal(`"ticketsAvailable" - ${quantity}`) },
    {
      where: { id: lotId, ticketsAvailable: { [Op.gte]: quantity } },
      transaction,
    }
  );
  return reserved > 0;
};

/**
 * Reservar el cupo de varias líneas a la vez: o se reservan todas o ninguna.
 * Si una falla, devuelve lo que ya había reservado para que la transacción pueda
 * terminar sin dejar cupo retenido
 * @param {{ lotId: string, quantity: number }[]} items
 * @returns {Promise<object|null>} la línea que no se pudo reservar, o null si todas
 */
const reserveItems = async (items, transaction) => {
  const reserved = [];
  for (const item of items) {
    if (!(await reserveStock(item.lotId, item.quantity, transaction))) {
      for (const done of reserved) {
        await Lot.increment("ticketsAvailable", {
          by: done.quantity,
          where: { id: done.lotId },
          transaction,
        });
      }
      return item;
    }
    reserved.push(item);
  }
  return null;
};

/**
 * Entradas que las compras pendientes retienen hoy en cada lote del evento
 * @returns {Promise<Map<string, number>>} lotId -> cantidad retenida
 */
const pendingByLot = async (eventId, transaction) => {
  const pending = await Purchase.findAll({
    where: { eventId, status: "pending" },
    include: [{ model: PurchaseItem, as: "items", attributes: ["lotId", "quantity"] }],
    transaction,
  });
  const held = new Map();
  const add = (lotId, quantity) => held.set(lotId, (held.get(lotId) || 0) + quantity);
  for (const purchase of pending) {
    if (purchase.items.length) purchase.items.forEach((i) => add(i.lotId, i.quantity));
    else if (purchase.lotId) add(purchase.lotId, purchase.quantity);
  }
  return held;
};

/**
 * Cancelar las compras que siguen pendientes pasado el tiempo de pago y
 * devolver su cupo al evento
 * @returns {Promise<number>} cantidad de compras liberadas
 */
const releaseExpiredPurchases = async () => {
  const cutoff = new Date(Date.now() - holdMinutes() * 60 * 1000);
  const expired = await Purchase.findAll({
    where: { status: "pending", createdAt: { [Op.lt]: cutoff } },
    attributes: ["id"],
  });

  let released = 0;
  for (const { id } of expired) {
    // Cada compra en su propia transacción, bloqueada y revalidada: si el pago
    // se aprobó mientras tanto, no se toca
    await sequelize.transaction(async (transaction) => {
      const purchase = await Purchase.findByPk(id, {
        lock: transaction.LOCK.UPDATE,
        transaction,
      });
      if (!purchase || purchase.status !== "pending") return;

      purchase.status = "failed";
      await purchase.save({ transaction });
      await releaseStock(purchase, transaction);
      released++;
    });
  }
  return released;
};

/**
 * Revisar periódicamente las compras vencidas (el timer no mantiene vivo el proceso)
 */
const startExpirationSweep = () => {
  const run = () =>
    releaseExpiredPurchases()
      .then((count) => {
        if (count) console.log(`Compras vencidas liberadas: ${count}`);
      })
      .catch((error) => console.error("Error al liberar compras vencidas:", error));

  run();
  return setInterval(run, SWEEP_INTERVAL_MS).unref();
};

module.exports = {
  itemsOf,
  releaseStock,
  reserveStock,
  reserveItems,
  pendingByLot,
  releaseExpiredPurchases,
  startExpirationSweep,
};
