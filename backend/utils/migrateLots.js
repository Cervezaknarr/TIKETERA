const { Op } = require("sequelize");
const Event = require("../models/Event");
const Lot = require("../models/Lot");
const Purchase = require("../models/Purchase");
const { sequelize } = require("../config/database");

/**
 * Los eventos creados antes de los lotes tenían un solo precio y cupo en el
 * propio evento. Se les crea un lote "General" con esos valores y se les asocian
 * sus compras. Es idempotente: solo toca eventos que todavía no tienen lotes
 * @returns {Promise<number>} cantidad de eventos migrados
 */
const migrateEventsToLots = async () => {
  const events = await Event.findAll({
    where: { ticketPrice: { [Op.ne]: null }, ticketsAvailable: { [Op.ne]: null } },
  });

  let migrated = 0;
  for (const event of events) {
    await sequelize.transaction(async (transaction) => {
      if ((await Lot.count({ where: { eventId: event.id }, transaction })) > 0) return;

      const purchases = await Purchase.findAll({ where: { eventId: event.id }, transaction });
      // La cantidad asignada incluye lo ya vendido o reservado
      const taken = purchases
        .filter((p) => p.status === "pending" || p.status === "completed")
        .reduce((sum, p) => sum + p.quantity, 0);

      const lot = await Lot.create(
        {
          eventId: event.id,
          name: "General",
          price: event.ticketPrice,
          quantity: event.ticketsAvailable + taken,
          ticketsAvailable: event.ticketsAvailable,
          position: 0,
        },
        { transaction }
      );

      // Ya no hay nada que migrar de este evento: el precio y el cupo viven en el lote
      await event.update({ ticketPrice: null, ticketsAvailable: null }, { transaction });

      for (const purchase of purchases) {
        if (purchase.lotId) continue;
        purchase.lotId = lot.id;
        purchase.lotName = lot.name;
        purchase.unitPrice = Number(purchase.totalPrice) / purchase.quantity;
        await purchase.save({ transaction });
      }
      migrated++;
    });
  }
  return migrated;
};

module.exports = { migrateEventsToLots };
