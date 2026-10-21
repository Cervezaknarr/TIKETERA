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
const { protect } = require("../middleware/authMiddleware");

// Rutas públicas
router.get("/", getEvents);
router.get("/:id", getEventById);

// Rutas protegidas
router.post("/", protect, createEvent);
router.put("/:id", protect, updateEvent);
router.delete("/:id", protect, deleteEvent);

// Lotes (tipos de entrada) del evento
router.post("/:eventId/lots", protect, addLot);
router.put("/:eventId/lots/:lotId", protect, updateLot);
router.delete("/:eventId/lots/:lotId", protect, deleteLot);

module.exports = router;
