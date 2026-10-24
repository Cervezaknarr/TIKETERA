const express = require("express");
const router = express.Router();
const {
  syncCheckin,
  getCheckinStats,
} = require("../controllers/checkinController");
const { protect, staff } = require("../middleware/authMiddleware");

// Rutas del control de acceso (staff o admin)
router.post("/events/:eventId/sync", protect, staff, syncCheckin);
router.get("/events/:eventId/stats", protect, staff, getCheckinStats);

module.exports = router;
