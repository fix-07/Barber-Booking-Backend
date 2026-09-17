const express = require("express");
const { body } = require("express-validator");

const {
  listApplications,
  approveApplication,
  rejectApplication,
  deleteApplication,
} = require("../controllers/adminBarberApprovalController");

const validate = require("../middleware/validate");
const validateObjectId = require("../middleware/validateObjectId");

const router = express.Router();

// requireAuth + requireRole("admin") applied once at the mount point in
// server.js.

const rejectRules = [
  body("reason")
    .optional({ values: "falsy" })
    .isString().trim().isLength({ max: 500 })
    .withMessage("Reason cannot be longer than 500 characters."),
];

router.get("/", listApplications);
router.patch("/:id/approve", validateObjectId("id"), approveApplication);
router.patch("/:id/reject", validateObjectId("id"), rejectRules, validate, rejectApplication);
router.delete("/:id", validateObjectId("id"), deleteApplication);

module.exports = router;
