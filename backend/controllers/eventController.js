const { Op } = require("sequelize");
const Event = require("../models/Event");
const Lot = require("../models/Lot");
const User = require("../models/User");
const Purchase = require("../models/Purchase");
const { sequelize } = require("../config/database");
const { parseLotInput, withLots } = require("../utils/lots");

const EVENT_STATUSES = ["draft", "published", "cancelled"];

const serverError = (res, error, message) => {
  console.error(error);
  res.status(500).json({
    success: false,
    message,
    error: process.env.NODE_ENV === "development" ? error.message : undefined,
  });
};

/**
 * @desc    Crear un nuevo evento con sus lotes (tipos de entrada)
 * @route   POST /api/events
 * @access  Private
 * @body    { title, description, date, location, imageUrl?,
 *            lots: [{ name, price, quantity }] }
 *          Sin `lots`, `ticketPrice` + `ticketsAvailable` crean un lote "General"
 */
const createEvent = async (req, res) => {
  try {
    const { title, description, date, location, imageUrl, ticketPrice, ticketsAvailable } =
      req.body;

    // Verificar campos obligatorios
    if (!title || !description || !date || !location) {
      return res.status(400).json({
        success: false,
        message: "Por favor completa todos los campos obligatorios",
      });
    }
    if (Number.isNaN(new Date(date).getTime())) {
      return res.status(400).json({ success: false, message: "La fecha del evento no es válida" });
    }

    // Lotes: la lista nueva, o el precio y cupo únicos del formato anterior
    let lotsInput = req.body.lots;
    if (lotsInput === undefined && ticketPrice !== undefined && ticketsAvailable !== undefined) {
      lotsInput = [{ name: "General", price: ticketPrice, quantity: ticketsAvailable }];
    }
    if (!Array.isArray(lotsInput) || lotsInput.length === 0) {
      return res.status(400).json({
        success: false,
        message: "El evento necesita al menos un lote de entradas",
      });
    }

    const lotsData = [];
    for (const input of lotsInput) {
      const { error, data } = parseLotInput(input || {});
      if (error) return res.status(400).json({ success: false, message: error });
      lotsData.push(data);
    }
    const names = lotsData.map((l) => l.name.toLowerCase());
    if (new Set(names).size !== names.length) {
      return res.status(400).json({
        success: false,
        message: "Hay lotes con el mismo nombre",
      });
    }

    const event = await sequelize.transaction(async (transaction) => {
      const created = await Event.create(
        {
          title,
          description,
          date,
          location,
          imageUrl,
          userId: req.user.id, // El userId viene del middleware de autenticación
        },
        { transaction }
      );
      await Lot.bulkCreate(
        lotsData.map((data, position) => ({
          ...data,
          eventId: created.id,
          ticketsAvailable: data.quantity,
          position,
        })),
        { transaction }
      );
      return created;
    });

    res.status(201).json({
      success: true,
      event: await withLots(event),
    });
  } catch (error) {
    serverError(res, error, "Error al crear el evento");
  }
};

/**
 * @desc    Obtener un evento por ID
 * @route   GET /api/events/:id
 * @access  Public
 */
const getEventById = async (req, res) => {
  try {
    // El parámetro es el ID o el slug (la URL pública /e/<slug>)
    const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      req.params.id
    );
    const include = [
      {
        model: User,
        attributes: ["name"], // Solo incluir el nombre del organizador
      },
    ];
    const event = isId
      ? await Event.findByPk(req.params.id, { include })
      : await Event.findOne({ where: { slug: req.params.id }, include });

    if (event) {
      res.json({
        success: true,
        event: await withLots(event),
      });
    } else {
      res.status(404).json({
        success: false,
        message: "Evento no encontrado",
      });
    }
  } catch (error) {
    serverError(res, error, "Error al obtener el evento");
  }
};

/**
 * @desc    Obtener todos los eventos (con paginación)
 * @route   GET /api/events
 * @access  Public
 */
const getEvents = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1; // Página actual, por defecto 1
    const limit = parseInt(req.query.limit) || 10; // Límite por página, por defecto 10
    const offset = (page - 1) * limit; // Cálculo del desplazamiento

    // Filtros opcionales
    const where = {};

    // Filtrar por fecha (eventos futuros)
    if (req.query.future === "true") {
      where.date = {
        [Op.gte]: new Date(),
      };
    }

    // Filtrar por estado
    if (req.query.status) {
      where.status = req.query.status;
    }

    const { count, rows } = await Event.findAndCountAll({
      where,
      limit,
      offset,
      include: [
        {
          model: User,
          attributes: ["name"],
        },
      ],
      order: [["date", "ASC"]], // Ordenar por fecha ascendente
    });

    res.json({
      success: true,
      events: await withLots(rows),
      pagination: {
        totalItems: count,
        totalPages: Math.ceil(count / limit),
        currentPage: page,
        itemsPerPage: limit,
      },
    });
  } catch (error) {
    serverError(res, error, "Error al obtener los eventos");
  }
};

/**
 * @desc    Editar los datos de un evento. Solo su organizador (o un admin).
 *          Los precios y cupos se editan en los lotes
 * @route   PUT /api/events/:id
 * @access  Private
 */
const updateEvent = async (req, res) => {
  try {
    const event = await Event.findByPk(req.params.id);

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Evento no encontrado",
      });
    }

    // Verificar si el usuario es el propietario del evento
    if (event.userId !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "No tienes permiso para actualizar este evento",
      });
    }

    const { title, description, date, location, imageUrl, status } = req.body;

    // Los textos obligatorios no pueden quedar vacíos
    for (const [field, value] of Object.entries({ title, description, location })) {
      if (value !== undefined && (typeof value !== "string" || !value.trim())) {
        return res.status(400).json({
          success: false,
          message: "El título, la descripción y el lugar no pueden quedar vacíos",
        });
      }
    }
    if (date !== undefined && Number.isNaN(new Date(date).getTime())) {
      return res.status(400).json({ success: false, message: "La fecha del evento no es válida" });
    }
    if (status !== undefined && !EVENT_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: "Estado del evento inválido" });
    }

    // Solo actualizar los campos proporcionados
    if (title !== undefined) event.title = title.trim();
    if (description !== undefined) event.description = description.trim();
    if (date !== undefined) event.date = date;
    if (location !== undefined) event.location = location.trim();
    if (imageUrl !== undefined) event.imageUrl = imageUrl || null;
    if (status !== undefined) event.status = status;

    await event.save();

    res.json({
      success: true,
      event: await withLots(event),
    });
  } catch (error) {
    serverError(res, error, "Error al actualizar el evento");
  }
};

/**
 * @desc    Eliminar un evento
 * @route   DELETE /api/events/:id
 * @access  Private
 */
const deleteEvent = async (req, res) => {
  try {
    const event = await Event.findByPk(req.params.id);

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Evento no encontrado",
      });
    }

    // Verificar si el usuario es el propietario del evento o es admin
    if (event.userId !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "No tienes permiso para eliminar este evento",
      });
    }

    // Verificar si hay compras asociadas al evento
    const purchasesCount = await Purchase.count({
      where: { eventId: event.id },
    });

    if (purchasesCount > 0) {
      // Si hay compras, en lugar de eliminar, cambiar el estado a cancelado
      event.status = "cancelled";
      await event.save();

      return res.json({
        success: true,
        message:
          "El evento ha sido cancelado porque ya tiene compras asociadas",
      });
    }

    // Si no hay compras, eliminar el evento con sus lotes
    await sequelize.transaction(async (transaction) => {
      await Lot.destroy({ where: { eventId: event.id }, transaction });
      await event.destroy({ transaction });
    });

    res.json({
      success: true,
      message: "Evento eliminado correctamente",
    });
  } catch (error) {
    serverError(res, error, "Error al eliminar el evento");
  }
};

module.exports = {
  createEvent,
  getEventById,
  getEvents,
  updateEvent,
  deleteEvent,
};
