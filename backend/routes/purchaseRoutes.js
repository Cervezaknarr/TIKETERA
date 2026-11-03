const express = require("express");
const router = express.Router();
const {
  createCheckoutSession,
  handlePaymentWebhook,
  getSalesStatus,
  getEventPurchases,
  getPurchaseTickets,
} = require("../controllers/purchaseController");
const { protect, admin } = require("../middleware/authMiddleware");

// Rutas públicas
router.get("/status", getSalesStatus);
router.post("/checkout", createCheckoutSession);
router.post("/webhook", handlePaymentWebhook);
router.get("/tickets/:accessToken", getPurchaseTickets);

// Rutas de administración
router.get("/event/:eventId", protect, admin, getEventPurchases);

module.exports = router;
