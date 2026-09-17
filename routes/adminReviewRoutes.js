const express = require("express");
const { body, query } = require("express-validator");

const {
  listReviews,
  approveReview,
  hideReview,
  respondToReview,
  deleteReview,
} = require("../controllers/adminReviewController");

const validate = require("../middleware/validate");
const validateObjectId = require("../middleware/validateObjectId");

const router = express.Router();

// requireAuth + requireRole("admin") applied once at the mount point in
// server.js.

const listRules = [
  query("status").optional().isIn(["pending", "approved", "hidden"]),
  query("barberId").optional().isMongoId(),
];

const respondRules = [
  body("adminResponse").isString().trim().isLength({ max: 1000 }),
];

router.get("/", listRules, validate, listReviews);
router.patch("/:id/approve", validateObjectId("id"), approveReview);
router.patch("/:id/hide", validateObjectId("id"), hideReview);
router.patch("/:id/respond", validateObjectId("id"), respondRules, validate, respondToReview);
router.delete("/:id", validateObjectId("id"), deleteReview);

module.exports = router;
