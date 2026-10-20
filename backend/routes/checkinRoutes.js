const express = require("express");
const router = express.Router();
const {
  syncCheckin,
  getCheckinStats,
} = require("../controllers/checkinController");
const { protect } = require("../middleware/authMiddleware");

// Rutas protegidas (staff, admin u organizador del evento; se verifica en el controlador)
router.post("/events/:eventId/sync", protect, syncCheckin);
router.get("/events/:eventId/stats", protect, getCheckinStats);

module.exports = router;
