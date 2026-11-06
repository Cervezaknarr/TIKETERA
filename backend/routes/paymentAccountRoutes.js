const express = require("express");
const router = express.Router();
const { getPaymentStatus, updateSalesPaused } = require("../controllers/paymentAccountController");
const { protect, admin } = require("../middleware/authMiddleware");

// Estado de los cobros y pausa general de ventas: solo para admin. Las cuentas de Mercado Pago
// son de cada evento y se manejan en /api/organizer/events/:eventId/payments
router.use(protect, admin);

router.get("/", getPaymentStatus);
router.put("/sales-paused", updateSalesPaused);

module.exports = router;
