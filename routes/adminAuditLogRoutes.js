const express = require("express");
const { query } = require("express-validator");

const { listAuditLogs } = require("../controllers/adminAuditLogController");
const validate = require("../middleware/validate");

const router = express.Router();

// requireAuth + requireRole("admin") applied once at the mount point in
// server.js.

const listRules = [
  query("resourceType").optional().isString().trim().isLength({ max: 40 }),
  query("action").optional().isString().trim().isLength({ max: 60 }),
];

// Read only. No POST/PATCH/DELETE here on purpose -- see the controller.
router.get("/", listRules, validate, listAuditLogs);

module.exports = router;
