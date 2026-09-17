const express = require("express");
const { body, query } = require("express-validator");

const {
  createBooking,
  listMyBookings,
  listMyAppointments,
  getBooking,
  cancelBooking,
  updateBookingStatus,
  getAvailability,
} = require("../controllers/bookingController");

const { requireAuth, requireRole, requireActiveBarber, requireActiveCustomer } = require("../middleware/auth");
const validate = require("../middleware/validate");
const validateObjectId = require("../middleware/validateObjectId");
const { createRateLimiter } = require("../middleware/rateLimit");

const router = express.Router();

/**
 * A tighter limit on creating bookings than the general one.
 *
 * WHY: a logged-in customer making 30 bookings a minute is not a customer,
 * it is a script. Holding slots en masse would deny the barber real
 * business, and every held slot is a slot a genuine customer cannot take.
 */
const bookingCreateLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 20,
  message:
    "You have made a lot of booking requests. Please wait a few minutes before trying again.",
});

const createRules = [
  body("serviceId")
    .isMongoId()
    .withMessage("Please choose a service."),

  // ISO8601 means a string like "2026-06-01T09:00:00.000Z". We require that
  // exact shape rather than accepting anything Date() can parse, because
  // new Date("tomorrow") and new Date("01/02/2026") are ambiguous or
  // silently wrong, and a wrong appointment date is a real-world problem.
  body("startAt")
    .isISO8601()
    .withMessage("Please choose a date and time."),

  body("customerNote")
    .optional({ values: "falsy" })
    .isString().trim()
    .isLength({ max: 300 })
    .withMessage("Note cannot be longer than 300 characters."),
];

const cancelRules = [
  body("reason")
    .optional({ values: "falsy" })
    .isString().trim()
    .isLength({ max: 300 })
    .withMessage("Reason cannot be longer than 300 characters."),
];

const statusRules = [
  body("status")
    .isIn(["confirmed", "completed", "no_show", "cancelled_by_barber"])
    .withMessage(
      "Status must be confirmed, completed, no_show or cancelled_by_barber."
    ),

  body("reason")
    .optional({ values: "falsy" })
    .isString().trim()
    .isLength({ max: 300 })
    .withMessage("Reason cannot be longer than 300 characters."),
];

const availabilityRules = [
  query("barberId").isMongoId().withMessage("A barber must be chosen."),
  query("serviceId").isMongoId().withMessage("A service must be chosen."),
  query("date")
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage("Date must be in the format YYYY-MM-DD."),
];

/**
 * ROUTE ORDER: the fixed paths ("/mine", "/appointments", "/availability")
 * come before "/:id", or Express would treat those words as ids.
 */

// PUBLIC: free slots, so a visitor can look before signing up.
router.get("/availability", availabilityRules, validate, getAvailability);

// CUSTOMER ONLY
router.get("/mine", requireAuth, requireRole("customer"), requireActiveCustomer, listMyBookings);

router.post(
  "/",
  requireAuth,
  requireRole("customer"),
  requireActiveCustomer,
  bookingCreateLimiter,
  createRules,
  validate,
  createBooking
);

// BARBER ONLY
router.get(
  "/appointments",
  requireAuth,
  requireRole("barber"),
  requireActiveBarber,
  listMyAppointments
);

router.patch(
  "/:id/status",
  requireAuth,
  requireRole("barber"),
  requireActiveBarber,
  validateObjectId("id"),
  statusRules,
  validate,
  updateBookingStatus
);

// EITHER SIDE, but only for their own booking. The controller checks which
// side the logged-in user is on.
router.get("/:id", requireAuth, validateObjectId("id"), getBooking);

router.patch(
  "/:id/cancel",
  requireAuth,
  validateObjectId("id"),
  cancelRules,
  validate,
  cancelBooking
);

module.exports = router;
