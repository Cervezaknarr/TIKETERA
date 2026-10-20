const Event = require("../models/Event");
const User = require("../models/User");
const Purchase = require("../models/Purchase");
const { sequelize } = require("../config/database");

/**
 * @desc    Crear un nuevo evento
 * @route   POST /api/events
 * @access  Private
 */
const createEvent = async (req, res) => {
  try {
    const {
      title,
      description,
      date,
      location,
      ticketPrice,
      ticketsAvailable,
      imageUrl,
    } = req.body;

    // Verificar campos obligatorios
    if (
      !title ||
      !description ||
      !date ||
      !location ||
      !ticketPrice ||
      !ticketsAvailable
    ) {
      return res.status(400).json({
        success: false,
        message: "Por favor completa todos los campos obligatorios",
      });
    }

    // Crear el evento
    const event = await Event.create({
      title,
      description,
      date,
      location,
      ticketPrice,
      ticketsAvailable,
      imageUrl,
      userId: req.user.id, // El userId viene del middleware de autenticación
    });

    res.status(201).json({
      success: true,
      event,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Error al crear el evento",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

/**
 * @desc    Obtener un evento por ID
 * @route   GET /api/events/:id
 * @access  Public
 */
const getEventById = async (req, res) => {
  try {
    const event = await Event.findByPk(req.params.id, {
      include: [
        {
          model: User,
          attributes: ["name"], // Solo incluir el nombre del organizador
        },
      ],
    });

    if (event) {
      res.json({
        success: true,
        event,
      });
    } else {
      res.status(404).json({
        success: false,
        message: "Evento no encontrado",
      });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Error al obtener el evento",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
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
        [sequelize.Op.gte]: new Date(),
      };
    }

    // Filtrar por estado
    if (req.query.status) {
      where.status = req.query.status;
    }

    const { count, rows: events } = await Event.findAndCountAll({
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
      events,
      pagination: {
        totalItems: count,
        totalPages: Math.ceil(count / limit),
        currentPage: page,
        itemsPerPage: limit,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Error al obtener los eventos",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

/**
 * @desc    Actualizar un evento
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

    // Actualizar el evento
    const {
      title,
      description,
      date,
      location,
      ticketPrice,
      ticketsAvailable,
      imageUrl,
      status,
    } = req.body;

    // Solo actualizar los campos proporcionados
    if (title) event.title = title;
    if (description) event.description = description;
    if (date) event.date = date;
    if (location) event.location = location;
    if (ticketPrice) event.ticketPrice = ticketPrice;
    if (ticketsAvailable) event.ticketsAvailable = ticketsAvailable;
    if (imageUrl) event.imageUrl = imageUrl;
    if (status) event.status = status;

    await event.save();

    res.json({
      success: true,
      event,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Error al actualizar el evento",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
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

    // Si no hay compras, eliminar el evento
    await event.destroy();

    res.json({
      success: true,
      message: "Evento eliminado correctamente",
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Error al eliminar el evento",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

module.exports = {
  createEvent,
  getEventById,
  getEvents,
  updateEvent,
  deleteEvent,
};
