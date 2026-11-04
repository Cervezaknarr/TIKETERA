const { Op, UniqueConstraintError } = require("sequelize");
const Event = require("../models/Event");
const Purchase = require("../models/Purchase");
const Ticket = require("../models/Ticket");
const Scan = require("../models/Scan");
const { sequelize } = require("../config/database");
const { normalizeTicketCode } = require("../utils/ticketCode");
const { eventIdsOfStaff } = require("../utils/staffEvents");
const { auditBulk } = require("../utils/audit");

// Máximo de escaneos por request (un dispositivo offline puede acumular muchos)
const MAX_SCANS_PER_SYNC = 500;
// Margen al pedir cambios incrementales, para no perder updates que se
// confirmaron justo mientras se respondía el sync anterior
const SINCE_OVERLAP_MS = 60 * 1000;

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
});

/**
 * Registrar un escaneo. Es idempotente: si el mismo escaneo (mismo id) llega
 * dos veces, devuelve el resultado original sin volver a procesarlo
 * @returns {Promise<{result: string, ticket: Ticket|null}>}
 */
const applyScan = async ({ scan, eventId, deviceId, staffUserId }) => {
  const existing = await Scan.findByPk(scan.id, { include: [Ticket] });
  if (existing) {
    // Un escaneo de OTRO evento no se devuelve ni se toca: para este evento es inválido
    // (no es un reenvío, así que se audita como rechazo)
    if (existing.eventId !== eventId) return { result: "invalid", ticket: null };
    return { result: existing.result, ticket: existing.Ticket, replayed: true };
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
      if (saved) {
        if (saved.eventId !== eventId) return { result: "invalid", ticket: null };
        return { result: saved.result, ticket: saved.Ticket, replayed: true };
      }
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
 * @access  Staff/Admin
 * @body    { deviceId, since?, scans: [{ id, code, scannedAt }] }
 */
const syncCheckin = async (req, res) => {
  try {
    const { eventId } = req.params;
    const { deviceId, since, scans = [] } = req.body;

    if (!deviceId || typeof deviceId !== "string" || deviceId.length > 64) {
      return res.status(400).json({
        success: false,
        message: "deviceId es requerido (hasta 64 caracteres)",
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
    if (event.status === "cancelled") {
      return res.status(400).json({
        success: false,
        message: "El evento está cancelado",
      });
    }

    // Procesar en orden: si el mismo dispositivo escaneó dos veces la misma
    // entrada, la primera es "admitted" y la segunda "duplicate"
    const results = [];
    const auditEntries = [];
    for (const scan of scans) {
      const { result, ticket, replayed } = await applyScan({
        scan,
        eventId,
        deviceId,
        staffUserId: req.user.id,
      });
      // Los reenvíos de un escaneo ya guardado no se vuelven a auditar. Sin datos del
      // comprador ni el código en bruto. Se insertan juntos al final del loop
      if (!replayed) {
        auditEntries.push({
          action: result === "admitted" ? "CHECKIN_OK" : "CHECKIN_REJECTED",
          entityType: "Ticket",
          entityId: ticket ? ticket.id : null,
          eventId,
          result: result === "admitted" ? "success" : result === "invalid" ? "failure" : "denied",
          details: { scanId: scan.id, scanResult: result, deviceId: deviceId.slice(0, 64) },
        });
      }
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

    // Un único insert para todo el sync, fuera de cualquier transacción (no falla el sync)
    await auditBulk(req, auditEntries);

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
      include: [{ model: Purchase, attributes: ["buyerName"] }],
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
 * @access  Staff/Admin
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

/**
 * @desc    Eventos publicados donde quien consulta puede escanear: todos para el admin;
 *          los suyos para el organizador; los asignados para el staff
 * @route   GET /api/checkin/my-events
 * @access  Staff/Organizador/Admin
 */
const getMyEvents = async (req, res) => {
  try {
    const where = { status: "published" };
    if (req.user.role === "organizer") where.organizerId = req.user.id;
    else if (req.user.role === "staff") where.id = await eventIdsOfStaff(req.user.id);

    const events = await Event.findAll({
      where,
      attributes: ["id", "title", "date", "slug"],
      order: [["date", "ASC"]],
    });
    res.json({ success: true, events });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Error al obtener los eventos" });
  }
};

module.exports = {
  syncCheckin,
  getCheckinStats,
  getMyEvents,
};
