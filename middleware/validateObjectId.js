const mongoose = require("mongoose");

/**
 * Checks that a URL parameter is a valid MongoDB ObjectId
 * BEFORE we try to use it in a query.
 *
 * WHY THIS MATTERS:
 * A MongoDB id looks like "6aa59709e035d21ac49b927b" - exactly 24 hex
 * characters. If someone requests /api/bookings/hello, Mongoose throws a
 * CastError deep inside the database layer. That works, but it means:
 *   - an ugly error path for something that is simply a bad URL
 *   - a confusing 500-shaped failure instead of a clear 400
 *
 * Checking up front turns "the database complained" into
 * "you gave me a malformed id", which is both clearer and one less
 * unexpected error path in your app.
 *
 * Usage:
 *   router.get("/:id", validateObjectId("id"), handler)
 */
const validateObjectId = (paramName = "id") => {
  return (req, res, next) => {
    const value = req.params[paramName];

    if (!mongoose.Types.ObjectId.isValid(value)) {
      return res.status(400).json({ message: "Invalid id provided." });
    }

    // isValid() is slightly loose: it also accepts any 12-character
    // string. Comparing the round-trip makes sure we got a real 24-char
    // hex id and not something like "abcdefghijkl".
    if (String(new mongoose.Types.ObjectId(value)) !== String(value).toLowerCase()) {
      return res.status(400).json({ message: "Invalid id provided." });
    }

    next();
  };
};

module.exports = validateObjectId;
