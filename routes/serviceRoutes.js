const express = require("express");
const { body } = require("express-validator");

const {
  listMyServices,
  createService,
  updateService,
  deleteService,
} = require("../controllers/serviceController");

const { requireAuth, requireRole, requireActiveBarber } = require("../middleware/auth");
const validate = require("../middleware/validate");
const validateObjectId = require("../middleware/validateObjectId");

const router = express.Router();

/**
 * Note there is no "barber" field in these rules.
 *
 * That is intentional, and it is the security control: the owner is taken
 * from the verified token in the controller. If we accepted a barber id
 * here, a barber could create services in someone else's shop.
 */
const createRules = [
  body("name")
    .isString().withMessage("Service name is required.")
    .trim()
    .isLength({ min: 2, max: 80 })
    .withMessage("Service name must be between 2 and 80 characters."),

  body("description")
    .optional({ values: "falsy" })
    .isString().trim()
    .isLength({ max: 400 })
    .withMessage("Description cannot be longer than 400 characters."),

  body("durationMinutes")
    .isInt({ min: 5, max: 480 })
    .withMessage("Duration must be a whole number between 5 and 480 minutes.")
    .toInt(),

  // Price is in minor units: 1250 means 12.50. See models/Service.js for
  // why money is never stored as a decimal.
  body("priceMinor")
    .isInt({ min: 0, max: 100000000 })
    .withMessage(
      "Price must be a whole number in minor units, for example 1250 for 12.50."
    )
    .toInt(),

  body("currency")
    .isString().withMessage("Currency is required.")
    .trim()
    .toUpperCase()
    .matches(/^[A-Z]{3}$/)
    .withMessage("Currency must be a 3-letter code such as GBP, USD or PKR."),
];

// On update every field is optional, because the barber may want to change
// only the price. But if a field IS sent, it must still be valid.
const updateRules = [
  body("name")
    .optional()
    .isString().trim()
    .isLength({ min: 2, max: 80 })
    .withMessage("Service name must be between 2 and 80 characters."),

  body("description")
    .optional()
    .isString().trim()
    .isLength({ max: 400 })
    .withMessage("Description cannot be longer than 400 characters."),

  body("durationMinutes")
    .optional()
    .isInt({ min: 5, max: 480 })
    .withMessage("Duration must be a whole number between 5 and 480 minutes.")
    .toInt(),

  body("priceMinor")
    .optional()
    .isInt({ min: 0, max: 100000000 })
    .withMessage("Price must be a whole number in minor units.")
    .toInt(),

  body("currency")
    .optional()
    .isString().trim().toUpperCase()
    .matches(/^[A-Z]{3}$/)
    .withMessage("Currency must be a 3-letter code such as GBP, USD or PKR."),

  body("isActive")
    .optional()
    .isBoolean().withMessage("isActive must be true or false.")
    .toBoolean(),
];

// Every route here is barber-only, and gated by requireActiveBarber on top
// of requireRole -- a pending/rejected/suspended barber has no services to
// manage yet. Customers browsing a barber's services get them from
// GET /api/barbers/:barberId instead, which returns only the active ones.
router.get("/mine", requireAuth, requireRole("barber"), requireActiveBarber, listMyServices);

router.post(
  "/",
  requireAuth,
  requireRole("barber"),
  requireActiveBarber,
  createRules,
  validate,
  createService
);

router.put(
  "/:id",
  requireAuth,
  requireRole("barber"),
  requireActiveBarber,
  validateObjectId("id"),
  updateRules,
  validate,
  updateService
);

router.delete(
  "/:id",
  requireAuth,
  requireRole("barber"),
  requireActiveBarber,
  validateObjectId("id"),
  deleteService
);

module.exports = router;
