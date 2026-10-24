const express = require("express");
const router = express.Router();
const {
  getUsers,
  createStaffUser,
  updateStaffUser,
  deleteStaffUser,
} = require("../controllers/userController");
const { protect, admin } = require("../middleware/authMiddleware");

// Gestión del personal: todas las rutas son solo para admin
router.use(protect, admin);

router.get("/", getUsers);
router.post("/", createStaffUser);
router.put("/:id", updateStaffUser);
router.delete("/:id", deleteStaffUser);

module.exports = router;
