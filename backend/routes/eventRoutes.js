const express = require("express");
const router = express.Router();
const {
  createEvent,
  getEventById,
  getEvents,
  updateEvent,
  deleteEvent,
} = require("../controllers/eventController");
const { protect } = require("../middleware/authMiddleware");

// Rutas públicas
router.get("/", getEvents);
router.get("/:id", getEventById);

// Rutas protegidas
router.post("/", protect, createEvent);
router.put("/:id", protect, updateEvent);
router.delete("/:id", protect, deleteEvent);

module.exports = router;
