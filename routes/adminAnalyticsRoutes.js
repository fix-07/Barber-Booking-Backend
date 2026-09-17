const express = require("express");
const { query } = require("express-validator");

const { getOverview } = require("../controllers/adminAnalyticsController");
const validate = require("../middleware/validate");

const router = express.Router();

// requireAuth + requireRole("admin") applied once at the mount point in
// server.js.

const overviewRules = [
  query("range").optional().isIn(["today", "7d", "30d", "90d"]),
];

router.get("/overview", overviewRules, validate, getOverview);

module.exports = router;
