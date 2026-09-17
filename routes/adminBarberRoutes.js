const express = require("express");
const { body } = require("express-validator");

const {
  listBarbers,
  getBarber,
  createBarber,
  updateBarber,
  deleteBarber,
  suspendBarber,
  reactivateBarber,
} = require("../controllers/adminBarberController");

const validate = require("../middleware/validate");
const validateObjectId = require("../middleware/validateObjectId");
const { isValidTimeZone, timeToMinutes } = require("../utils/schedule");

const router = express.Router();

// requireAuth + requireRole("admin") applied once at the mount point in
// server.js.

const createRules = [
  body("name").isString().trim().isLength({ min: 2, max: 60 }),
  body("email").isEmail(),
  body("phone").isString().trim().isLength({ min: 1, max: 30 }),
  body("shopName").isString().trim().isLength({ min: 2, max: 80 }),
  body("city").isString().trim().isLength({ min: 2, max: 80 }),
  body("timeZone").isString().trim().custom(isValidTimeZone),
  body("bio").optional({ values: "falsy" }).isString().trim().isLength({ max: 600 }),
  body("addressLine").optional({ values: "falsy" }).isString().trim().isLength({ max: 160 }),
  body("publicPhone").optional({ values: "falsy" }).isString().trim().isLength({ max: 30 }),
];

// Same shape as barberRoutes.js's profileRules, plus timeOff -- kept as a
// second list rather than shared, since this one also allows editing the
// account's name/phone, which the barber's own route never should.
const updateRules = [
  body("shopName").optional().isString().trim().isLength({ min: 2, max: 80 }),
  body("city").optional().isString().trim().isLength({ min: 2, max: 80 }),
  body("timeZone").optional().isString().trim().custom(isValidTimeZone),
  body("bio").optional({ values: "falsy" }).isString().trim().isLength({ max: 600 }),
  body("addressLine").optional({ values: "falsy" }).isString().trim().isLength({ max: 160 }),
  body("publicPhone").optional({ values: "falsy" }).isString().trim().isLength({ max: 30 }),
  body("name").optional().isString().trim().isLength({ min: 2, max: 60 }),
  body("phone").optional().isString().trim().isLength({ min: 1, max: 30 }),

  body("workingHours").optional().isArray({ max: 7 }),
  body("workingHours.*.day").optional().isInt({ min: 0, max: 6 }),
  body("workingHours.*.isOpen").optional().isBoolean().toBoolean(),
  body("workingHours.*.open").optional({ values: "falsy" }).custom((v) => timeToMinutes(v) !== null),
  body("workingHours.*.close").optional({ values: "falsy" }).custom((v) => timeToMinutes(v) !== null),
  body("workingHours.*.breakStart").optional({ values: "falsy" }).custom((v) => timeToMinutes(v) !== null),
  body("workingHours.*.breakEnd").optional({ values: "falsy" }).custom((v) => timeToMinutes(v) !== null),

  body("timeOff").optional().isArray({ max: 50 }),
  body("timeOff.*.startDate").matches(/^\d{4}-\d{2}-\d{2}$/),
  body("timeOff.*.endDate").matches(/^\d{4}-\d{2}-\d{2}$/),
  body("timeOff.*.reason").optional({ values: "falsy" }).isString().trim().isLength({ max: 200 }),

  body("isPublished").optional().isBoolean().toBoolean(),
  body("isAcceptingBookings").optional().isBoolean().toBoolean(),
];

router.get("/", listBarbers);
router.post("/", createRules, validate, createBarber);
router.get("/:id", validateObjectId("id"), getBarber);
router.patch("/:id", validateObjectId("id"), updateRules, validate, updateBarber);
router.patch("/:id/suspend", validateObjectId("id"), suspendBarber);
router.patch("/:id/reactivate", validateObjectId("id"), reactivateBarber);
router.delete("/:id", validateObjectId("id"), deleteBarber);

module.exports = router;
