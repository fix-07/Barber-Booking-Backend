const express = require("express");
const { body } = require("express-validator");

const {
  listClients,
  getClient,
  createClient,
  updateClient,
  deleteClient,
  suspendClient,
  reactivateClient,
} = require("../controllers/adminClientController");

const validate = require("../middleware/validate");
const validateObjectId = require("../middleware/validateObjectId");

const router = express.Router();

// requireAuth + requireRole("admin") applied once at the mount point in
// server.js.

const createRules = [
  body("name").isString().trim().isLength({ min: 2, max: 60 }).withMessage("Name is required."),
  body("email").isEmail().withMessage("A valid email is required."),
  body("phone").isString().trim().isLength({ min: 1, max: 30 }).withMessage("Phone is required."),
];

const updateRules = [
  body("name").optional().isString().trim().isLength({ min: 2, max: 60 }),
  body("phone").optional().isString().trim().isLength({ min: 1, max: 30 }),
  body("email").optional().isEmail(),
  body("adminNotes").optional({ values: "falsy" }).isString().trim().isLength({ max: 2000 }),
];

router.get("/", listClients);
router.post("/", createRules, validate, createClient);
router.get("/:id", validateObjectId("id"), getClient);
router.patch("/:id", validateObjectId("id"), updateRules, validate, updateClient);
router.patch("/:id/suspend", validateObjectId("id"), suspendClient);
router.patch("/:id/reactivate", validateObjectId("id"), reactivateClient);
router.delete("/:id", validateObjectId("id"), deleteClient);

module.exports = router;
