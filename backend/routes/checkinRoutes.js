const express = require("express");
const router = express.Router();
const {
  syncCheckin,
  getCheckinStats,
  getMyEvents,
} = require("../controllers/checkinController");
const { protect, staff, scanAccess } = require("../middleware/authMiddleware");

// Rutas del control de acceso (staff o admin)
// Eventos donde puede escanear quien consulta (el selector del escáner)
router.get("/my-events", protect, staff, getMyEvents);
router.post("/events/:eventId/sync", protect, staff, scanAccess, syncCheckin);
router.get("/events/:eventId/stats", protect, staff, scanAccess, getCheckinStats);

module.exports = router;
