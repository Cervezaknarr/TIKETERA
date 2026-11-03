const { Op } = require("sequelize");
const Event = require("../models/Event");
const Lot = require("../models/Lot");
const Purchase = require("../models/Purchase");
const { sequelize } = require("../config/database");
const { parseLotInput } = require("../utils/lots");

/**
 * Buscar el evento y verificar que el usuario logueado puede administrarlo.
 * Si no puede, responde el error y devuelve null
 */
const findManagedEvent = async (req, res) => {
  const event = await Event.findByPk(req.params.eventId);
  if (!event) {
    res.status(404).json({ success: false, message: "Evento no encontrado" });
    return null;
  }
  if (event.userId !== req.user.id && req.user.role !== "admin") {
    res.status(403).json({
      success: false,
      message: "No tienes permiso para modificar los lotes de este evento",
    });
    return null;
  }
  return event;
};

const nameTaken = async (eventId, name, exceptId) => {
  const lots = await Lot.findAll({ where: { eventId } });
  return lots.some((l) => l.id !== exceptId && l.name.toLowerCase() === name.toLowerCase());
};

const serverError = (res, error, message) => {
  console.error(error);
  res.status(500).json({
    success: false,
    message,
    error: process.env.NODE_ENV === "development" ? error.message : undefined,
  });
};

/**
 * @desc    Agregar un lote a un evento
 * @route   POST /api/events/:eventId/lots
 * @access  Private (organizador del evento)
 */
const addLot = async (req, res) => {
  try {
    const event = await findManagedEvent(req, res);
    if (!event) return;

    const { error, data } = parseLotInput(req.body);
    if (error) return res.status(400).json({ success: false, message: error });
    if (await nameTaken(event.id, data.name)) {
      return res.status(400).json({ success: false, message: "Ya existe un lote con ese nombre" });
    }

    const position = (await Lot.max("position", { where: { eventId: event.id } })) ?? -1;
    const lot = await Lot.create({
      ...data,
      eventId: event.id,
      ticketsAvailable: data.quantity,
      position: position + 1,
    });
    res.status(201).json({ success: true, lot });
  } catch (error) {
    serverError(res, error, "Error al agregar el lote");
  }
};

/**
 * @desc    Editar un lote: nombre, precio y cantidad asignada. Mandar
 *          `soldOut: true` lo agota (la cantidad pasa a ser lo ya vendido)
 * @route   PUT /api/events/:eventId/lots/:lotId
 * @access  Private (organizador del evento)
 */
const updateLot = async (req, res) => {
  try {
    const event = await findManagedEvent(req, res);
    if (!event) return;

    const lot = await Lot.findOne({ where: { id: req.params.lotId, eventId: event.id } });
    if (!lot) return res.status(404).json({ success: false, message: "Lote no encontrado" });

    const { error, data } = parseLotInput(req.body, { partial: true });
    if (error) return res.status(400).json({ success: false, message: error });
    if (data.name && (await nameTaken(event.id, data.name, lot.id))) {
      return res.status(400).json({ success: false, message: "Ya existe un lote con ese nombre" });
    }

    await sequelize.transaction(async (transaction) => {
      // Nombre y precio solo cambian para las compras futuras
      const plain = {};
      if (data.name) plain.name = data.name;
      if (data.price !== undefined) plain.price = data.price;
      if (Object.keys(plain).length) await lot.update(plain, { transaction });

      if (req.body.soldOut === true) {
        // Atómico: la cantidad queda en lo vendido/reservado y no queda nada a la venta
        await Lot.update(
          { quantity: sequelize.literal('"quantity" - "ticketsAvailable"'), ticketsAvailable: 0 },
          { where: { id: lot.id }, transaction }
        );
      } else if (data.quantity !== undefined) {
        // Atómico: el cupo cambia por la diferencia de lo asignado, sin pisar las
        // compras que estén entrando. No se puede asignar menos de lo ya vendido
        // o reservado (quantity es un entero validado, es seguro interpolarlo)
        const [changed] = await Lot.update(
          {
            quantity: data.quantity,
            ticketsAvailable: sequelize.literal(`"ticketsAvailable" + (${data.quantity} - "quantity")`),
          },
          {
            where: {
              id: lot.id,
              [Op.and]: sequelize.literal(`"quantity" - "ticketsAvailable" <= ${data.quantity}`),
            },
            transaction,
          }
        );
        if (changed === 0) {
          const current = await Lot.findByPk(lot.id, { transaction });
          const sold = current.quantity - current.ticketsAvailable;
          const err = new Error(
            `No se puede asignar menos de ${sold}: ya hay ${sold} entradas vendidas o reservadas en este lote`
          );
          err.status = 400;
          throw err;
        }
      }
    });

    res.json({ success: true, lot: await Lot.findByPk(lot.id) });
  } catch (error) {
    if (error.status === 400) {
      return res.status(400).json({ success: false, message: error.message });
    }
    serverError(res, error, "Error al actualizar el lote");
  }
};

/**
 * @desc    Eliminar un lote que nunca se vendió. Si ya tiene compras, hay que
 *          agotarlo en lugar de borrarlo
 * @route   DELETE /api/events/:eventId/lots/:lotId
 * @access  Private (organizador del evento)
 */
const deleteLot = async (req, res) => {
  try {
    const event = await findManagedEvent(req, res);
    if (!event) return;

    const lot = await Lot.findOne({ where: { id: req.params.lotId, eventId: event.id } });
    if (!lot) return res.status(404).json({ success: false, message: "Lote no encontrado" });

    if ((await Lot.count({ where: { eventId: event.id } })) === 1) {
      return res.status(400).json({
        success: false,
        message: "El evento tiene que tener al menos un lote",
      });
    }
    if ((await Purchase.count({ where: { lotId: lot.id } })) > 0) {
      return res.status(400).json({
        success: false,
        message: "Este lote ya tiene compras: no se puede borrar, pero podés agotarlo",
      });
    }

    await lot.destroy();
    res.json({ success: true, message: "Lote eliminado" });
  } catch (error) {
    serverError(res, error, "Error al eliminar el lote");
  }
};

module.exports = { addLot, updateLot, deleteLot };
