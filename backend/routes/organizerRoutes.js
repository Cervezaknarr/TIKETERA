const express = require("express");
const router = express.Router();
const {
  getMyEvents,
  getStaff,
  createStaff,
  updateStaff,
  deleteStaff,
  getPayments,
  setSalesPaused,
  activateAccount,
  deleteAccount,
} = require("../controllers/organizerController");
const { createPaymentAccount } = require("../controllers/paymentAccountController");
const { protect, organizer, eventManager } = require("../middleware/authMiddleware");

// Panel del organizador: solo organizadores (y admins). Las rutas de un evento
// pasan por eventManager, que exige ser el organizador de ESE evento
router.use(protect, organizer);

router.get("/events", getMyEvents);

router.get("/events/:eventId/staff", eventManager, getStaff);
router.post("/events/:eventId/staff", eventManager, createStaff);
router.put("/events/:eventId/staff/:id", eventManager, updateStaff);
router.delete("/events/:eventId/staff/:id", eventManager, deleteStaff);

router.get("/events/:eventId/payments", eventManager, getPayments);
router.put("/events/:eventId/sales-paused", eventManager, setSalesPaused);
router.post("/events/:eventId/payments/accounts", eventManager, createPaymentAccount);
router.post("/events/:eventId/payments/accounts/:id/activate", eventManager, activateAccount);
router.delete("/events/:eventId/payments/accounts/:id", eventManager, deleteAccount);

module.exports = router;
