const express = require("express");
const { body } = require("express-validator");

const { createReview, getMyReviews } = require("../controllers/reviewController");
const { requireAuth, requireRole, requireActiveCustomer } = require("../middleware/auth");
const validate = require("../middleware/validate");

const router = express.Router();

router.post(
  "/",
  requireAuth,
  requireRole("customer"),
  requireActiveCustomer,
  [
    body("bookingId").isMongoId().withMessage("A valid booking is required."),
    body("rating")
      .isInt({ min: 1, max: 5 })
      .withMessage("Rating must be a whole number between 1 and 5."),
    body("comment")
      .optional({ values: "falsy" })
      .isString()
      .trim()
      .isLength({ max: 1000 })
      .withMessage("Comment cannot exceed 1000 characters."),
  ],
  validate,
  createReview
);

router.get("/mine", requireAuth, requireRole("customer"), getMyReviews);

module.exports = router;
