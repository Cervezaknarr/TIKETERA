const express = require("express");
const router = express.Router();
const {
  getPaymentAccounts,
  createPaymentAccount,
  activatePaymentAccount,
  deletePaymentAccount,
  updateSalesPaused,
} = require("../controllers/paymentAccountController");
const { protect, admin } = require("../middleware/authMiddleware");

// Cuentas de cobro y pausa de ventas: solo para admin
router.use(protect, admin);

router.get("/", getPaymentAccounts);
router.post("/", createPaymentAccount);
router.put("/sales-paused", updateSalesPaused);
router.post("/:id/activate", activatePaymentAccount);
router.delete("/:id", deletePaymentAccount);

module.exports = router;
