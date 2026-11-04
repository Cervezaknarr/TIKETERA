const express = require("express");
const router = express.Router();
const { getAuditLogs } = require("../controllers/auditController");
const { protect, admin } = require("../middleware/authMiddleware");

// Registro de auditoría: solo admin (un organizador recibe 403)
router.get("/", protect, admin, getAuditLogs);

module.exports = router;
