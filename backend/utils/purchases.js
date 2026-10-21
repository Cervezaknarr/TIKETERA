const { Op } = require("sequelize");
const Event = require("../models/Event");
const Purchase = require("../models/Purchase");
const { sequelize } = require("../config/database");

// Las preferencias de pago vencen a los 30 minutos; el margen cubre pagos que
// se están acreditando justo en ese momento
const DEFAULT_HOLD_MINUTES = 40;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Devolver las entradas de una compra al inventario del evento
 */
const releaseStock = (purchase, transaction) =>
  Event.increment("ticketsAvailable", {
    by: purchase.quantity,
    where: { id: purchase.eventId },
    transaction,
  });

/**
 * Descuento atómico: solo se aplica si todavía quedan entradas, así dos compras
 * simultáneas de las últimas entradas no pueden vender de más
 * (quantity es un entero validado, es seguro interpolarlo)
 * @returns {Promise<boolean>} true si se pudo reservar el cupo
 */
const reserveStock = async (eventId, quantity, transaction) => {
  const [reserved] = await Event.update(
    { ticketsAvailable: sequelize.literal(`"ticketsAvailable" - ${quantity}`) },
    {
      where: { id: eventId, ticketsAvailable: { [Op.gte]: quantity } },
      transaction,
    }
  );
  return reserved > 0;
};

const holdMinutes = () => Number(process.env.PURCHASE_HOLD_MINUTES) || DEFAULT_HOLD_MINUTES;

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
