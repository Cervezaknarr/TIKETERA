const Lot = require("../models/Lot");
const Pack = require("../models/Pack");
const { parsePackInput } = require("../utils/packs");
const { findManagedEvent } = require("./lotController");

const serverError = (res, error, message) => {
  console.error(error);
  res.status(500).json({
    success: false,
    message,
    error: process.env.NODE_ENV === "development" ? error.message : undefined,
  });
};

const toJSON = (pack) => ({ ...pack.toJSON(), discountPercent: Number(pack.discountPercent) });

// Un mismo lote no puede tener dos paquetes con la misma cantidad de entradas
const duplicated = async (eventId, lotId, quantity, exceptId) => {
  const packs = await Pack.findAll({ where: { eventId, lotId, quantity } });
  return packs.some((p) => p.id !== exceptId);
};

/**
 * @desc    Crear un paquete (promo) en un evento: N entradas de un lote con X% de descuento
 * @route   POST /api/events/:eventId/packs
 * @access  Private (organizador del evento)
 * @body    { lotId, quantity, discountPercent }
 */
const addPack = async (req, res) => {
  try {
    const event = await findManagedEvent(req, res);
    if (!event) return;

    const { error, data } = parsePackInput(req.body);
    if (error) return res.status(400).json({ success: false, message: error });

    const lot = await Lot.findOne({ where: { id: data.lotId, eventId: event.id } });
    if (!lot) return res.status(400).json({ success: false, message: "El lote no pertenece a este evento" });
    if (await duplicated(event.id, lot.id, data.quantity)) {
      return res.status(400).json({
        success: false,
        message: `Ya existe un paquete de ${data.quantity} entradas para ${lot.name}`,
      });
    }

    const pack = await Pack.create({ ...data, eventId: event.id });
    res.status(201).json({ success: true, pack: toJSON(pack) });
  } catch (error) {
    serverError(res, error, "Error al crear el paquete");
  }
};

/**
 * @desc    Editar un paquete. Solo afecta las compras nuevas
 * @route   PUT /api/events/:eventId/packs/:packId
 * @access  Private (organizador del evento)
 */
const updatePack = async (req, res) => {
  try {
    const event = await findManagedEvent(req, res);
    if (!event) return;

    const pack = await Pack.findOne({ where: { id: req.params.packId, eventId: event.id } });
    if (!pack) return res.status(404).json({ success: false, message: "Paquete no encontrado" });

    const { error, data } = parsePackInput(req.body, { partial: true });
    if (error) return res.status(400).json({ success: false, message: error });

    if (data.lotId && !(await Lot.findOne({ where: { id: data.lotId, eventId: event.id } }))) {
      return res.status(400).json({ success: false, message: "El lote no pertenece a este evento" });
    }
    const lotId = data.lotId || pack.lotId;
    const quantity = data.quantity || pack.quantity;
    if (await duplicated(event.id, lotId, quantity, pack.id)) {
      return res.status(400).json({
        success: false,
        message: `Ya existe un paquete de ${quantity} entradas para ese lote`,
      });
    }

    await pack.update(data);
    res.json({ success: true, pack: toJSON(pack) });
  } catch (error) {
    serverError(res, error, "Error al actualizar el paquete");
  }
};

/**
 * @desc    Borrar un paquete. Las compras ya hechas conservan su precio y sus entradas
 * @route   DELETE /api/events/:eventId/packs/:packId
 * @access  Private (organizador del evento)
 */
const deletePack = async (req, res) => {
  try {
    const event = await findManagedEvent(req, res);
    if (!event) return;

    const pack = await Pack.findOne({ where: { id: req.params.packId, eventId: event.id } });
    if (!pack) return res.status(404).json({ success: false, message: "Paquete no encontrado" });

    await pack.destroy();
    res.json({ success: true, message: "Paquete eliminado" });
  } catch (error) {
    serverError(res, error, "Error al eliminar el paquete");
  }
};

module.exports = { addPack, updatePack, deletePack };
