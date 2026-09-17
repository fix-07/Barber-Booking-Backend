/**
 * Protects against MongoDB operator injection.
 *
 * THE ATTACK, in plain terms:
 * Your login route does  User.findOne({ email: req.body.email }).
 * If someone sends JSON like
 *     { "email": { "$ne": null }, "password": "anything" }
 * then req.body.email is an OBJECT, not a string, and the query becomes
 *     User.findOne({ email: { $ne: null } })
 * which means "find any user whose email is not null" - it returns the
 * first user in your database and skips the email check entirely.
 *
 * THE FIX:
 * MongoDB operators always start with "$". Keys containing "." can be used
 * to reach into nested fields. We strip any such key before the data is
 * ever used in a query.
 *
 * This is a hand-written replacement for the "express-mongo-sanitize"
 * package. We also validate types with express-validator, so this is a
 * second layer of defence rather than the only one.
 */

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const stripDangerousKeys = (value) => {
  if (Array.isArray(value)) {
    value.forEach(stripDangerousKeys);
    return value;
  }

  if (!isPlainObject(value)) return value;

  for (const key of Object.keys(value)) {
    if (key.startsWith("$") || key.includes(".")) {
      delete value[key];
      continue;
    }
    stripDangerousKeys(value[key]);
  }

  return value;
};

const sanitizeRequest = (req, res, next) => {
  if (req.body) stripDangerousKeys(req.body);
  if (req.params) stripDangerousKeys(req.params);

  // In Express 5, req.query is a getter, so we cannot always edit it
  // directly. We build a cleaned copy and pin it onto the request.
  if (req.query && Object.keys(req.query).length > 0) {
    const cleaned = stripDangerousKeys({ ...req.query });
    try {
      Object.defineProperty(req, "query", {
        value: cleaned,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    } catch {
      // If the platform will not let us replace it, the explicit
      // express-validator checks on each route still guard the query.
    }
  }

  next();
};

module.exports = sanitizeRequest;
