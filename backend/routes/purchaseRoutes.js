const express = require("express");
const router = express.Router();
const {
  createCheckoutSession,
  handlePaymentWebhook,
  getSalesStatus,
  getEventPurchases,
  getPurchaseTickets,
} = require("../controllers/purchaseController");
const { protect, eventManager } = require("../middleware/authMiddleware");

// Rutas públicas
router.get("/status", getSalesStatus);
router.post("/checkout", createCheckoutSession);
router.post("/webhook", handlePaymentWebhook);
router.get("/tickets/:accessToken", getPurchaseTickets);

// Compradores de un evento: el admin o el organizador de ese evento
router.get("/event/:eventId", protect, eventManager, getEventPurchases);

module.exports = router;
