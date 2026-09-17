const BusinessSettings = require("../models/BusinessSettings");

/**
 * GET /api/settings
 * PUBLIC, no auth -- the customer-facing Footer and the four legal pages
 * need this before anyone has logged in. Returns the same shape
 * client/src/config/business.js's static `business` object used to have,
 * so the frontend components that already know how to render it (and
 * highlight anything still a bracketed placeholder) need no reshaping.
 */
const getSettings = async (req, res) => {
  const settings = await BusinessSettings.getOrCreate();
  res.status(200).json({ business: settings.toJSON() });
};

module.exports = { getSettings };
