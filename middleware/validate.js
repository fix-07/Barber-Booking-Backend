const { validationResult } = require("express-validator");

/**
 * Turns express-validator's findings into one tidy 400 response.
 *
 * Put this LAST in a route's middleware list, after the rules:
 *   router.post("/register", registerRules, validate, handler)
 *
 * The response shape is:
 *   { message: "...", errors: { email: "Enter a valid email address" } }
 * A field-keyed object is easy for React to show next to the right input,
 * which also helps screen-reader users because each message can be tied
 * to its own field.
 */
const validate = (req, res, next) => {
  const result = validationResult(req);
  if (result.isEmpty()) return next();

  const errors = {};
  for (const error of result.array()) {
    // Keep the first message per field so the user is not overwhelmed.
    if (!errors[error.path]) errors[error.path] = error.msg;
  }

  return res.status(400).json({
    message: "Please correct the highlighted fields.",
    errors,
  });
};

module.exports = validate;
