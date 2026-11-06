const express = require("express");
const router = express.Router();
const {
  listCourtesies,
  createCourtesy,
  updateCourtesy,
  sendCourtesy,
  voidCourtesy,
} = require("../controllers/courtesyController");
const { protect, admin } = require("../middleware/authMiddleware");

// Cortesías (entradas sin pago): solo el admin las genera y administra
router.use(protect, admin);

router.get("/event/:eventId", listCourtesies);
router.post("/event/:eventId", createCourtesy);
router.put("/event/:eventId/:id", updateCourtesy);
router.post("/event/:eventId/:id/send", sendCourtesy);
router.post("/event/:eventId/:id/void", voidCourtesy);

module.exports = router;
