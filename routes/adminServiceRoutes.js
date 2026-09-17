const express = require("express");
const { body } = require("express-validator");

const {
  listAllServices,
  createServiceForBarber,
  updateAnyService,
  deleteAnyService,
} = require("../controllers/adminServiceController");

const validate = require("../middleware/validate");
const validateObjectId = require("../middleware/validateObjectId");

const router = express.Router();

// requireAuth + requireRole("admin") applied once at the mount point in
// server.js.

// Same rules as serviceRoutes.js's createRules/updateRules, plus barberId
// here since staff choose the owner explicitly.
const createRules = [
  body("barberId").isMongoId().withMessage("Please choose a barber."),
  body("name").isString().trim().isLength({ min: 2, max: 80 }),
  body("description").optional({ values: "falsy" }).isString().trim().isLength({ max: 400 }),
  body("durationMinutes").isInt({ min: 5, max: 480 }).toInt(),
  body("priceMinor").isInt({ min: 0, max: 100000000 }).toInt(),
  body("currency").isString().trim().toUpperCase().matches(/^[A-Z]{3}$/),
];

const updateRules = [
  body("name").optional().isString().trim().isLength({ min: 2, max: 80 }),
  body("description").optional().isString().trim().isLength({ max: 400 }),
  body("durationMinutes").optional().isInt({ min: 5, max: 480 }).toInt(),
  body("priceMinor").optional().isInt({ min: 0, max: 100000000 }).toInt(),
  body("currency").optional().isString().trim().toUpperCase().matches(/^[A-Z]{3}$/),
  body("isActive").optional().isBoolean().toBoolean(),
];

router.get("/", listAllServices);
router.post("/", createRules, validate, createServiceForBarber);
router.patch("/:id", validateObjectId("id"), updateRules, validate, updateAnyService);
router.delete("/:id", validateObjectId("id"), deleteAnyService);

module.exports = router;
