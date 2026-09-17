const express = require("express");
const { body } = require("express-validator");

const { getAdminSettings, updateAdminSettings } = require("../controllers/adminSettingsController");
const validate = require("../middleware/validate");

const router = express.Router();

// requireAuth + requireRole("admin") applied once at the mount point in
// server.js.

const updateRules = [
  body("name").optional().isString().trim().isLength({ min: 1, max: 120 }),
  body("legalName").optional().isString().trim().isLength({ min: 1, max: 160 }),
  body("email").optional().isString().trim().isLength({ max: 254 }),
  body("phone").optional().isString().trim().isLength({ max: 30 }),
  body("address").optional().isString().trim().isLength({ max: 300 }),
  body("registration").optional().isString().trim().isLength({ max: 120 }),
  body("hours").optional().isString().trim().isLength({ max: 300 }),
  body("jurisdiction").optional().isString().trim().isLength({ max: 120 }),
  body("policyUpdated").optional().isString().trim().isLength({ max: 60 }),
  body("cancellationPolicy").optional({ values: "falsy" }).isString().trim().isLength({ max: 2000 }),
];

router.get("/", getAdminSettings);
router.patch("/", updateRules, validate, updateAdminSettings);

module.exports = router;
