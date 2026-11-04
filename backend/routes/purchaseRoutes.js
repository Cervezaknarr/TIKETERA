const express = require("express");
const router = express.Router();
const {
  createCheckoutSession,
  handlePaymentWebhook,
  getSalesStatus,
  getEventPurchases,
  getPurchaseTickets,
  resendPurchaseEmail,
  voidPurchaseFromPanel,
} = require("../controllers/purchaseController");
const { protect, eventManager } = require("../middleware/authMiddleware");
const { webhookLimiter, ticketLinkLimiter } = require("../middleware/rateLimit");

// Rutas públicas
router.get("/status", getSalesStatus);
router.post("/checkout", createCheckoutSession);
router.post("/webhook", webhookLimiter(), handlePaymentWebhook);
router.get("/tickets/:accessToken", ticketLinkLimiter(), getPurchaseTickets);

// Compradores de un evento: el admin o el organizador de ese evento
router.get("/event/:eventId", protect, eventManager, getEventPurchases);
router.post("/event/:eventId/:purchaseId/resend", protect, eventManager, resendPurchaseEmail);
router.post("/event/:eventId/:purchaseId/void", protect, eventManager, voidPurchaseFromPanel);

module.exports = router;
