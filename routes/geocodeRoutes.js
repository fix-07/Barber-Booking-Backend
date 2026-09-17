const express = require("express");
const { createRateLimiter } = require("../middleware/rateLimit");
const { search } = require("../controllers/geocodeController");

const router = express.Router();

/**
 * Deliberately stricter than the general API limiter: this endpoint's
 * upstream (Nominatim) asks for roughly 1 request/second PER SOURCE, and
 * this server is one source no matter how many visitors are typing into
 * the location box at once. 30/minute per IP is generous for a genuine
 * search-as-you-type box (a person cannot type that fast) while keeping
 * this server's total call volume to something Nominatim's free,
 * volunteer-run service is meant for.
 */
const geocodeLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  message: "Too many location searches. Please wait a moment and try again.",
});

router.get("/search", geocodeLimiter, search);

module.exports = router;
