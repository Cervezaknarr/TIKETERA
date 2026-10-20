const { Op, UniqueConstraintError } = require("sequelize");
const Event = require("../models/Event");
const Purchase = require("../models/Purchase");
const Ticket = require("../models/Ticket");
const Scan = require("../models/Scan");
const { sequelize } = require("../config/database");
const { normalizeTicketCode } = require("../utils/ticketCode");

// Máximo de escaneos por request (un dispositivo offline puede acumular muchos)
const MAX_SCANS_PER_SYNC = 500;
// Margen al pedir cambios incrementales, para no perder updates que se
// confirmaron justo mientras se respondía el sync anterior
const SINCE_OVERLAP_MS = 60 * 1000;

/**
 * Pueden controlar el acceso el staff, los admin y el organizador del evento
 */
const canCheckIn = (user, event) =>
  user.role === "staff" || user.role === "admin" || event.userId === user.id;

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Formato de entrada que se envía a la app de staff
 */
const serializeTicket = (ticket) => ({
  code: ticket.code,
  status: ticket.status,
  usedAt: ticket.usedAt,
  usedByDevice: ticket.usedByDevice,
  holderName: ticket.holderName,
  buyerName: ticket.Purchase ? ticket.Purchase.buyerName : null,
  buyerEmail: ticket.Purchase ? ticket.Purchase.buyerEmail : null,
});

/**
 * Registrar un escaneo. Es idempotente: si el mismo escaneo (mismo id) llega
 * dos veces, devuelve el resultado original sin volver a procesarlo
 * @returns {Promise<{result: string, ticket: Ticket|null}>}
 */
const applyScan = async ({ scan, eventId, deviceId, staffUserId }) => {
  const existing = await Scan.findByPk(scan.id, { include: [Ticket] });
  if (existing) {
    return { result: existing.result, ticket: existing.Ticket };
  }

  const code = normalizeTicketCode(scan.code);
  // Nunca registrar un ingreso en el futuro aunque el reloj del celular esté adelantado
  const scannedAt = new Date(
    Math.min(new Date(scan.scannedAt).getTime(), Date.now())
  );

  try {
    return await sequelize.transaction(async (transaction) => {
      const ticket = code
        ? await Ticket.findOne({ where: { code, eventId }, transaction })
        : null;

      let result;
      if (!ticket) {
        result = "invalid";
      } else if (ticket.status === "void") {
        result = "void";
      } else {
        // Update condicional: solo una request puede pasar la entrada de
        // "valid" a "used", aunque dos dispositivos la escaneen a la vez
        const [affected] = await Ticket.update(
          { status: "used", usedAt: scannedAt, usedByDevice: deviceId },
          { where: { id: ticket.id, status: "valid" }, transaction }
        );
        result = affected === 1 ? "admitted" : "duplicate";
        await ticket.reload({ transaction });
      }

      await Scan.create(
        {
          id: scan.id,
          eventId,
          ticketId: ticket ? ticket.id : null,
          code: code || String(scan.code).slice(0, 64),
          deviceId,
          staffUserId,
          scannedAt,
          result,
        },
        { transaction }
      );

      return { result, ticket };
    });
  } catch (error) {
    // Dos requests con el mismo escaneo en paralelo: la otra ya lo guardó
    if (error instanceof UniqueConstraintError) {
      const saved = await Scan.findByPk(scan.id, { include: [Ticket] });
      if (saved) return { result: saved.result, ticket: saved.Ticket };
    }
    throw error;
  }
};

/**
 * @desc    Sincronizar la app de control de acceso con el servidor.
 *          Recibe los escaneos hechos en el dispositivo (online u offline) y
 *          devuelve el resultado de cada uno, más las entradas que cambiaron
 *          desde `since` (o todas si no se manda `since`)
 * @route   POST /api/checkin/events/:eventId/sync
 * @access  Private (staff/admin)
 * @body    { deviceId, since?, scans: [{ id, code, scannedAt }] }
 */
const syncCheckin = async (req, res) => {
  try {
    const { eventId } = req.params;
    const { deviceId, since, scans = [] } = req.body;

    if (!deviceId || typeof deviceId !== "string") {
      return res.status(400).json({
        success: false,
        message: "deviceId es requerido",
      });
    }

    if (!Array.isArray(scans) || scans.length > MAX_SCANS_PER_SYNC) {
      return res.status(400).json({
        success: false,
        message: `scans debe ser una lista de hasta ${MAX_SCANS_PER_SYNC} elementos`,
      });
    }

    const invalidScan = scans.find(
      (scan) =>
        !scan ||
        !UUID_REGEX.test(scan.id) ||
        typeof scan.code !== "string" ||
        isNaN(new Date(scan.scannedAt).getTime())
    );
    if (invalidScan) {
      return res.status(400).json({
        success: false,
        message: "Cada escaneo debe tener id (UUID), code y scannedAt",
      });
    }

    const sinceDate = since ? new Date(since) : null;
    if (sinceDate && isNaN(sinceDate.getTime())) {
      return res.status(400).json({
        success: false,
        message: "since debe ser una fecha válida",
      });
    }

    const event = await Event.findByPk(eventId);
    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Evento no encontrado",
      });
    }

    if (!canCheckIn(req.user, event)) {
      return res.status(403).json({
        success: false,
        message: "No tienes permiso para controlar el acceso a este evento",
      });
    }

    // Procesar en orden: si el mismo dispositivo escaneó dos veces la misma
    // entrada, la primera es "admitted" y la segunda "duplicate"
    const results = [];
    for (const scan of scans) {
      const { result, ticket } = await applyScan({
        scan,
        eventId,
        deviceId,
        staffUserId: req.user.id,
      });
      results.push({
        id: scan.id,
        result,
        ticket: ticket
          ? {
              code: ticket.code,
              status: ticket.status,
              usedAt: ticket.usedAt,
              usedByDevice: ticket.usedByDevice,
            }
          : null,
      });
    }

    // Tomar la hora antes de consultar, así el próximo sync no se pierde nada
    const serverTime = new Date();

    const where = { eventId };
    if (sinceDate) {
      where.updatedAt = {
        [Op.gte]: new Date(sinceDate.getTime() - SINCE_OVERLAP_MS),
      };
    }

    const tickets = await Ticket.findAll({
      where,
      include: [{ model: Purchase, attributes: ["buyerName", "buyerEmail"] }],
      order: [["updatedAt", "ASC"]],
    });

    res.json({
      success: true,
      serverTime: serverTime.toISOString(),
      full: !sinceDate, // true = lista completa, el dispositivo reemplaza la suya
      tickets: tickets.map(serializeTicket),
      results,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Error al sincronizar el control de acceso",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

/**
 * @desc    Resumen de ingresos del evento (para el panel del organizador)
 * @route   GET /api/checkin/events/:eventId/stats
 * @access  Private (staff/admin)
 */
const getCheckinStats = async (req, res) => {
  try {
    const { eventId } = req.params;

    const event = await Event.findByPk(eventId);
    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Evento no encontrado",
      });
    }

    if (!canCheckIn(req.user, event)) {
      return res.status(403).json({
        success: false,
        message: "No tienes permiso para ver las estadísticas de este evento",
      });
    }

    const counts = await Ticket.count({
      where: { eventId },
      group: ["status"],
    });
    const byStatus = { valid: 0, used: 0, void: 0 };
    for (const row of counts) byStatus[row.status] = row.count;

    // Escaneos rechazados: duplicados, códigos inválidos o anulados
    const rejectedScans = await Scan.count({
      where: { eventId, result: { [Op.ne]: "admitted" } },
    });

    res.json({
      success: true,
      stats: {
        total: byStatus.valid + byStatus.used + byStatus.void,
        admitted: byStatus.used,
        pending: byStatus.valid,
        void: byStatus.void,
        rejectedScans,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Error al obtener las estadísticas",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

module.exports = {
  syncCheckin,
  getCheckinStats,
};
