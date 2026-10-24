const { Op } = require("sequelize");
const Lot = require("../models/Lot");
const Purchase = require("../models/Purchase");
const { sequelize } = require("../config/database");

const { holdMinutes } = require("./paymentWindow");

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Devolver las entradas de una compra al cupo de su lote
 */
const releaseStock = async (purchase, transaction) => {
  // Las compras anteriores a los lotes se migran al arrancar; por las dudas, una
  // sin lote no rompe el flujo
  if (!purchase.lotId) return;
  await Lot.increment("ticketsAvailable", {
    by: purchase.quantity,
    where: { id: purchase.lotId },
    transaction,
  });
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
  releaseStock,
  reserveStock,
  releaseExpiredPurchases,
  startExpirationSweep,
};
