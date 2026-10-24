const express = require("express");
const router = express.Router();
const {
  createEvent,
  getEventById,
  getEvents,
  updateEvent,
  deleteEvent,
} = require("../controllers/eventController");
const { protect, admin } = require("../middleware/authMiddleware");

// Rutas públicas
router.get("/", getEvents);
router.get("/:id", getEventById);

// Rutas de administración
router.post("/", protect, admin, createEvent);
router.put("/:id", protect, admin, updateEvent);
router.delete("/:id", protect, admin, deleteEvent);

module.exports = router;
