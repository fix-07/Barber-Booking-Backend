const express = require("express");
const { body, query } = require("express-validator");

const {
  listAllBookings,
  getBookingAsAdmin,
  adminCreateBooking,
  adminUpdateStatus,
  adminReschedule,
  recordPayment,
  deletePayment,
  deleteBooking,
} = require("../controllers/adminBookingController");

const Booking = require("../models/Booking");
const validate = require("../middleware/validate");
const validateObjectId = require("../middleware/validateObjectId");

const router = express.Router();

// requireAuth + requireRole("admin") are applied once, in server.js, to the
// whole /api/admin/bookings mount -- see the comment there.

const listRules = [
  query("barberId").optional().isMongoId(),
  query("serviceId").optional().isMongoId(),
  query("status").optional().isIn(Booking.BOOKING_STATUSES),
  query("paymentStatus").optional().isIn(["unpaid", "paid", "refunded", "failed"]),
  query("date").optional().matches(/^\d{4}-\d{2}-\d{2}$/),
  query("from").optional().matches(/^\d{4}-\d{2}-\d{2}$/),
  query("to").optional().matches(/^\d{4}-\d{2}-\d{2}$/),
];

/**
 * Either an existing client (existingUserId) or enough to create one
 * (name + email + phone) must be present. Neither half is individually
 * required by express-validator, because which one is required depends on
 * the other -- checked once here instead.
 */
const createRules = [
  body("serviceId").isMongoId().withMessage("Please choose a service."),
  body("barberId").isMongoId().withMessage("Please choose a barber."),
  body("startAt").isISO8601().withMessage("Please choose a date and time."),
  body("existingUserId").optional().isMongoId(),
  body("name").optional({ values: "falsy" }).isString().trim().isLength({ min: 2, max: 60 }),
  body("email").optional({ values: "falsy" }).isEmail(),
  body("phone").optional({ values: "falsy" }).isString().trim().isLength({ max: 30 }),
  body("staffNote").optional({ values: "falsy" }).isString().trim().isLength({ max: 500 }),
  body().custom((value) => {
    if (value.existingUserId) return true;
    if (value.name && value.email && value.phone) return true;
    throw new Error(
      "Choose an existing client, or provide a name, email and phone for a new one."
    );
  }),
];

const statusRules = [
  body("status")
    .isIn(Booking.BOOKING_STATUSES)
    .withMessage(`Status must be one of: ${Booking.BOOKING_STATUSES.join(", ")}.`),
  body("reason").optional({ values: "falsy" }).isString().trim().isLength({ max: 300 }),
];

const rescheduleRules = [
  body("startAt").isISO8601().withMessage("Please choose a date and time."),
];

const paymentRules = [
  body("status")
    .isIn(["unpaid", "paid", "refunded", "failed"])
    .withMessage("Payment status must be unpaid, paid, refunded or failed."),
  body("method").optional({ values: "falsy" }).isIn(["cash", "card", "other"]),
];

router.get("/", listRules, validate, listAllBookings);
router.post("/", createRules, validate, adminCreateBooking);
router.get("/:id", validateObjectId("id"), getBookingAsAdmin);
router.patch("/:id/status", validateObjectId("id"), statusRules, validate, adminUpdateStatus);
router.patch("/:id/reschedule", validateObjectId("id"), rescheduleRules, validate, adminReschedule);
router.patch("/:id/payment", validateObjectId("id"), paymentRules, validate, recordPayment);
router.delete("/:id/payment", validateObjectId("id"), deletePayment);
router.delete("/:id", validateObjectId("id"), deleteBooking);

module.exports = router;
