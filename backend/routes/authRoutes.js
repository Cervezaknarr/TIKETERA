const express = require("express");
const router = express.Router();
const { login, getUserProfile } = require("../controllers/authController");
const { protect } = require("../middleware/authMiddleware");

// Rutas públicas. No hay registro: los compradores no tienen cuenta y los
// usuarios staff los crea un admin (/api/users)
router.post("/login", login);

// Rutas protegidas
router.get("/profile", protect, getUserProfile);

module.exports = router;
