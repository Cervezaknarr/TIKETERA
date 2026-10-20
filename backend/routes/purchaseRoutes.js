const express = require("express");
const router = express.Router();
const {
  createCheckoutSession,
  handlePaymentWebhook,
  getEventPurchases,
  getPurchaseTickets,
} = require("../controllers/purchaseController");
const { protect } = require("../middleware/authMiddleware");

// Rutas públicas
router.post("/checkout", createCheckoutSession);
router.post("/webhook", handlePaymentWebhook);
router.get("/tickets/:accessToken", getPurchaseTickets);

// Rutas protegidas
router.get("/event/:eventId", protect, getEventPurchases);

module.exports = router;
