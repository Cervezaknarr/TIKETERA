const express = require("express");
const router = express.Router();
const {
  createEvent,
  getEventById,
  getEvents,
  updateEvent,
  deleteEvent,
} = require("../controllers/eventController");
const { addLot, updateLot, deleteLot, unlockLots } = require("../controllers/lotController");
const { protect, admin, optionalAdmin } = require("../middleware/authMiddleware");
const { codeLimiter } = require("../middleware/rateLimit");

// Rutas públicas
router.get("/", optionalAdmin, getEvents);
router.get("/:id", optionalAdmin, getEventById);
router.post("/:id/unlock", codeLimiter(), unlockLots);

// Rutas de administración
router.post("/", protect, admin, createEvent);
router.put("/:id", protect, admin, updateEvent);
router.delete("/:id", protect, admin, deleteEvent);

// Lotes (tipos de entrada) del evento: también solo el administrador
router.post("/:eventId/lots", protect, admin, addLot);
router.put("/:eventId/lots/:lotId", protect, admin, updateLot);
router.delete("/:eventId/lots/:lotId", protect, admin, deleteLot);

module.exports = router;
