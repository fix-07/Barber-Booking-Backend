const express = require("express");
const { getSettings } = require("../controllers/settingsController");

const router = express.Router();

// Public, no auth -- see settingsController.js.
router.get("/", getSettings);

module.exports = router;
