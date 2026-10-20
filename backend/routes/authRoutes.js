const express = require("express");
const router = express.Router();
const {
  register,
  login,
  getUserProfile,
} = require("../controllers/authController");
const { protect } = require("../middleware/authMiddleware");

// Rutas públicas
router.post("/register", register);
router.post("/login", login);

// Rutas protegidas
router.get("/profile", protect, getUserProfile);

module.exports = router;
