const express = require("express");
const { body } = require("express-validator");

const {
  listPublicBarbers,
  getPublicBarber,
  getMyBarberProfile,
  upsertMyBarberProfile,
  resubmitApplication,
  getMyApplicationStatus,
} = require("../controllers/barberController");

const { requireAuth, requireRole, requireActiveBarber } = require("../middleware/auth");
const validate = require("../middleware/validate");
const validateObjectId = require("../middleware/validateObjectId");
const { isValidTimeZone, timeToMinutes } = require("../utils/schedule");

const router = express.Router();

const profileRules = [
  body("shopName")
    .isString().withMessage("Shop name is required.")
    .trim()
    .isLength({ min: 2, max: 80 })
    .withMessage("Shop name must be between 2 and 80 characters."),

  body("city")
    .isString().withMessage("City or town is required.")
    .trim()
    .isLength({ min: 2, max: 80 })
    .withMessage("City must be between 2 and 80 characters."),

  body("timeZone")
    .isString().withMessage("Shop timezone is required.")
    .trim()
    .custom(isValidTimeZone)
    .withMessage(
      "Choose a timezone such as Europe/London or America/New_York."
    ),

  body("bio")
    .optional({ values: "falsy" })
    .isString().trim()
    .isLength({ max: 600 })
    .withMessage("Description cannot be longer than 600 characters."),

  body("addressLine")
    .optional({ values: "falsy" })
    .isString().trim()
    .isLength({ max: 160 })
    .withMessage("Address cannot be longer than 160 characters."),

  body("region")
    .optional({ values: "falsy" })
    .isString().trim()
    .isLength({ max: 80 }).withMessage("Region cannot be longer than 80 characters."),

  body("country")
    .optional({ values: "falsy" })
    .isString().trim()
    .isLength({ max: 80 }).withMessage("Country cannot be longer than 80 characters."),

  // Real coordinate validation, on the BACKEND -- a spoofed or malformed
  // pair from the client cannot get past .toFloat()'s NaN result once
  // upsertMyBarberProfile's own Number.isFinite check runs.
  body("latitude")
    .optional()
    .isFloat({ min: -90, max: 90 }).withMessage("Latitude must be between -90 and 90.")
    .toFloat(),

  body("longitude")
    .optional()
    .isFloat({ min: -180, max: 180 }).withMessage("Longitude must be between -180 and 180.")
    .toFloat(),

  body("locationConfirmed")
    .optional()
    .isBoolean().withMessage("locationConfirmed must be true or false.")
    .toBoolean(),

  body("publicPhone")
    .optional({ values: "falsy" })
    .isString().trim()
    .isLength({ max: 30 }).withMessage("Phone number is too long.")
    .matches(/^[0-9+()\-\s]+$/)
    .withMessage("Phone number may only contain digits, spaces, + ( ) and -."),

  body("workingHours")
    .optional()
    .isArray({ max: 7 })
    .withMessage("Opening hours must be a list of up to 7 days."),

  // Checking each item inside the array. Without this, someone could send
  // { day: 99 } or { open: "not a time" } and rely on the schema to catch
  // it, which produces a less helpful error.
  body("workingHours.*.day")
    .optional()
    .isInt({ min: 0, max: 6 })
    .withMessage("Day must be a number from 0 (Sunday) to 6 (Saturday)."),

  body("workingHours.*.isOpen")
    .optional()
    .isBoolean().withMessage("isOpen must be true or false.")
    .toBoolean(),

  body("workingHours.*.open")
    .optional({ values: "falsy" })
    .custom((value) => timeToMinutes(value) !== null)
    .withMessage("Opening time must look like 09:00 on a 24-hour clock."),

  body("workingHours.*.close")
    .optional({ values: "falsy" })
    .custom((value) => timeToMinutes(value) !== null)
    .withMessage("Closing time must look like 18:00 on a 24-hour clock."),

  body("workingHours.*.breakStart")
    .optional({ values: "falsy" })
    .custom((value) => timeToMinutes(value) !== null)
    .withMessage("Break start must look like 13:00 on a 24-hour clock."),

  body("workingHours.*.breakEnd")
    .optional({ values: "falsy" })
    .custom((value) => timeToMinutes(value) !== null)
    .withMessage("Break end must look like 13:30 on a 24-hour clock."),

  body("isPublished")
    .optional()
    .isBoolean().withMessage("isPublished must be true or false.")
    .toBoolean(),

  body("isAcceptingBookings")
    .optional()
    .isBoolean().withMessage("isAcceptingBookings must be true or false.")
    .toBoolean(),

  body("photoUrl")
    .optional({ values: "falsy" })
    .isString().trim().isLength({ max: 2000 })
    .withMessage("Photo link is too long."),

  body("experience")
    .optional({ values: "falsy" })
    .isString().trim().isLength({ max: 500 })
    .withMessage("Experience cannot be longer than 500 characters."),

  body("specialties")
    .optional()
    .isArray({ max: 10 }).withMessage("Up to 10 specialties."),
  body("specialties.*")
    .optional()
    .isString().trim().isLength({ min: 1, max: 40 })
    .withMessage("Each specialty must be 40 characters or fewer."),

  body("requestedServices")
    .optional()
    .isArray({ max: 10 }).withMessage("Up to 10 requested services."),
  body("requestedServices.*")
    .optional()
    .isString().trim().isLength({ min: 1, max: 80 })
    .withMessage("Each requested service must be 80 characters or fewer."),
];

/**
 * ROUTE ORDER MATTERS HERE.
 *
 * "/me" (and "/me/resubmit") must be declared BEFORE "/:barberId". Express
 * matches top to bottom, so if the parameter route came first it would
 * capture the word "me" as an id and try to look up a barber whose id is
 * "me".
 */
router.get("/me/status", requireAuth, requireRole("barber"), getMyApplicationStatus);

router.get("/me", requireAuth, requireRole("barber"), requireActiveBarber, getMyBarberProfile);

router.put(
  "/me",
  requireAuth,
  requireRole("barber"),
  requireActiveBarber,
  profileRules,
  validate,
  upsertMyBarberProfile
);

/**
 * PATCH /api/barbers/me/resubmit
 * Barber only, and deliberately WITHOUT requireActiveBarber -- a rejected
 * barber is exactly who needs to reach this route. Only actually does
 * anything when the account is currently "rejected"; see the controller.
 */
router.patch(
  "/me/resubmit",
  requireAuth,
  requireRole("barber"),
  profileRules,
  validate,
  resubmitApplication
);

// Public routes. No requireAuth, on purpose: browsing barbers must work
// before someone creates an account.
router.get("/", listPublicBarbers);
router.get("/:barberId", validateObjectId("barberId"), getPublicBarber);

module.exports = router;
