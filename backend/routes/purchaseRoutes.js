const express = require("express");
const router = express.Router();
const {
  createCheckoutSession,
  handlePaymentWebhook,
  getEventPurchases,
} = require("../controllers/purchaseController");
const { protect } = require("../middleware/authMiddleware");

// Rutas públicas
router.post("/checkout", createCheckoutSession);
router.post("/webhook", handlePaymentWebhook);

// Rutas protegidas
router.get("/event/:eventId", protect, getEventPurchases);

module.exports = router;
