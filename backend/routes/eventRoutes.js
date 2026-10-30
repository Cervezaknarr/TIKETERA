const express = require("express");
const router = express.Router();
const {
  createEvent,
  getEventById,
  getEvents,
  updateEvent,
  deleteEvent,
} = require("../controllers/eventController");
const { addLot, updateLot, deleteLot } = require("../controllers/lotController");
const { protect, admin, optionalAdmin } = require("../middleware/authMiddleware");

// Rutas públicas
router.get("/", optionalAdmin, getEvents);
router.get("/:id", optionalAdmin, getEventById);

// Rutas de administración
router.post("/", protect, admin, createEvent);
router.put("/:id", protect, admin, updateEvent);
router.delete("/:id", protect, admin, deleteEvent);

// Lotes (tipos de entrada) del evento: también solo el administrador
router.post("/:eventId/lots", protect, admin, addLot);
router.put("/:eventId/lots/:lotId", protect, admin, updateLot);
router.delete("/:eventId/lots/:lotId", protect, admin, deleteLot);

module.exports = router;
