const { Op } = require("sequelize");
const Event = require("../models/Event");
const Lot = require("../models/Lot");
const User = require("../models/User");
const Purchase = require("../models/Purchase");
const StaffEvent = require("../models/StaffEvent");
const { sequelize } = require("../config/database");
const { parseLotInput, withLots } = require("../utils/lots");
const { audit } = require("../utils/audit");

const EVENT_STATUSES = ["draft", "published", "cancelled"];
const MAX_PAGE_SIZE = 100;

// La portada es una imagen subida (data URL de hasta ~1,5 MB) o una URL http(s)
const MAX_IMAGE_LENGTH = 1_500_000;
const isValidImage = (value) =>
  typeof value === "string" &&
  value.length <= MAX_IMAGE_LENGTH &&
  /^(data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+|https?:\/\/\S+)$/.test(value);
const INVALID_IMAGE ="La portada tiene que ser una imagen JPG, PNG o WebP de hasta 1,5 MB";

// Edad mínima del evento. Acepta minAge (entero 1-99, o null/"" para quitarla) y,
// por compatibilidad, adultsOnly (true = 18, false = sin etiqueta).
// minAge undefined en el resultado = no tocar el valor actual.
const parseAgeFields = ({ minAge, adultsOnly }) => {
  if (minAge !== undefined) {
    if (minAge === null || minAge === "") return { minAge: null };
    const n = typeof minAge === "string" && /^\d+$/.test(minAge.trim()) ? Number(minAge) : minAge;
    if (!Number.isInteger(n) || n < 1 || n > 99) {
      return { error: "La edad mínima tiene que ser un número entero entre 1 y 99" };
    }
    return { minAge: n };
  }
  if (adultsOnly !== undefined) {
    if (typeof adultsOnly !== "boolean") return { error: "El campo de edad mínima es inválido" };
    return { minAge: adultsOnly ? 18 : null };
  }
  return { minAge: undefined };
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Organizador del evento: undefined = no tocar; null o "" = quitarlo; si no, tiene
// que ser el id de un usuario con rol "organizer"
const parseOrganizer = async (value) => {
  if (value === undefined) return {};
  if (value === null || value === "") return { organizerId: null };
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    return { error: "El organizador es inválido" };
  }
  const user = await User.findOne({ where: { id: value, role: "organizer" } });
  if (!user) return { error: "El organizador no existe" };
  return { organizerId: user.id };
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
 * @desc    Crear un nuevo evento con sus lotes (tipos de entrada)
 * @route   POST /api/events
 * @access  Private
 * @body    { title, description, date, location, imageUrl?, adultsOnly?,
 *            lots: [{ name, price, quantity }] }
 *          Sin `lots`, `ticketPrice` + `ticketsAvailable` crean un lote "General"
 */
const createEvent = async (req, res) => {
  try {
    const { title, description, date, location, imageUrl, ticketPrice, ticketsAvailable } =
      req.body;
    const status = req.body.status === undefined ? "draft" : req.body.status;
    if (!EVENT_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: "Estado del evento inválido" });
    }

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

    if (imageUrl && !isValidImage(imageUrl)) {
      return res.status(400).json({ success: false, message: INVALID_IMAGE });
    }
    const age = parseAgeFields(req.body);
    if (age.error) return res.status(400).json({ success: false, message: age.error });
    if (req.body.unlisted !== undefined && typeof req.body.unlisted !== "boolean") {
      return res.status(400).json({ success: false, message: "El campo «no listado» tiene que ser verdadero o falso" });
    }
    const organizer = await parseOrganizer(req.body.organizerId);
    if (organizer.error) return res.status(400).json({ success: false, message: organizer.error });

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
          imageUrl: imageUrl || null,
          adultsOnly: age.minAge != null,
          minAge: age.minAge ?? null,
          organizerId: organizer.organizerId ?? null,
          status,
          unlisted: req.body.unlisted === true,
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

    await audit(req, {
      action: "EVENT_CREATE",
      entityType: "Event",
      entityId: event.id,
      eventId: event.id,
      details: { status: event.status, organizerId: event.organizerId || null, lots: lotsData.length },
    });
    res.status(201).json({
      success: true,
      event: await withLots(event, { admin: true }),
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

    // Borradores y cancelados solo los ve el administrador
    if (event && (event.status === "published" || req.isAdmin)) {
      res.json({
        success: true,
        event: await withLots(event, { admin: req.isAdmin }),
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
    const page = req.query.page === undefined ? 1 : parseInt(req.query.page);
    let limit = req.query.limit === undefined ? 10 : parseInt(req.query.limit);
    if (!(page >= 1) || !(limit >= 1)) {
      return res.status(400).json({ success: false, message: "Paginación inválida" });
    }
    limit = Math.min(limit, MAX_PAGE_SIZE);
    const offset = (page - 1) * limit; // Cálculo del desplazamiento

    // Filtros opcionales
    const where = {};

    // Filtrar por fecha (eventos futuros)
    if (req.query.future === "true") {
      where.date = {
        [Op.gte]: new Date(),
      };
    }

    // El público solo ve los publicados; el administrador puede filtrar por cualquier estado
    if (!req.isAdmin) {
      where.status = "published";
      where.unlisted = false; // los no listados solo se abren con su link
    } else if (req.query.status) {
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
      events: await withLots(rows, { admin: req.isAdmin }),
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
    if (imageUrl && !isValidImage(imageUrl)) {
      return res.status(400).json({ success: false, message: INVALID_IMAGE });
    }
    if (status !== undefined && !EVENT_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: "Estado del evento inválido" });
    }
    const age = parseAgeFields(req.body);
    if (age.error) return res.status(400).json({ success: false, message: age.error });
    if (req.body.unlisted !== undefined && typeof req.body.unlisted !== "boolean") {
      return res.status(400).json({ success: false, message: "El campo «no listado» tiene que ser verdadero o falso" });
    }
    const organizer = await parseOrganizer(req.body.organizerId);
    if (organizer.error) return res.status(400).json({ success: false, message: organizer.error });

    // Solo actualizar los campos proporcionados
    if (title !== undefined) event.title = title.trim();
    if (description !== undefined) event.description = description.trim();
    if (date !== undefined) event.date = date;
    if (location !== undefined) event.location = location.trim();
    if (imageUrl !== undefined) event.imageUrl = imageUrl || null;
    if (status !== undefined) event.status = status;
    if (req.body.unlisted !== undefined) event.unlisted = req.body.unlisted;
    if (organizer.organizerId !== undefined) event.organizerId = organizer.organizerId;
    if (age.minAge !== undefined) {
      event.minAge = age.minAge;
      event.adultsOnly = age.minAge != null;
    }

    // Solo los campos que cambiaron; portada y textos largos: únicamente que cambiaron
    const changed = event.changed() || [];
    const details = {};
    for (const key of changed) {
      if (["status", "organizerId", "minAge", "unlisted"].includes(key)) {
        details[key] = { from: event.previous(key) ?? null, to: event.get(key) ?? null };
      } else if (key !== "adultsOnly" && key !== "slug") {
        details[key] = true;
      }
    }
    await event.save();
    await audit(req, {
      action: "EVENT_UPDATE",
      entityType: "Event",
      entityId: event.id,
      eventId: event.id,
      details,
    });

    res.json({
      success: true,
      event: await withLots(event, { admin: true }),
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
      const previousStatus = event.status;
      event.status = "cancelled";
      await event.save();
      await audit(req, {
        action: "EVENT_DELETE",
        entityType: "Event",
        entityId: event.id,
        eventId: event.id,
        details: { cancelledInsteadOfDeleted: true, status: { from: previousStatus, to: "cancelled" } },
      });

      return res.json({
        success: true,
        message:
          "El evento ha sido cancelado porque ya tiene compras asociadas",
      });
    }

    // Si no hay compras, eliminar el evento con sus lotes
    await sequelize.transaction(async (transaction) => {
      await Lot.destroy({ where: { eventId: event.id }, transaction });
      await StaffEvent.destroy({ where: { eventId: event.id }, transaction });
      await event.destroy({ transaction });
    });
    await audit(req, { action: "EVENT_DELETE", entityType: "Event", entityId: event.id, eventId: event.id });

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
