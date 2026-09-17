/**
 * Shared helpers for list/search endpoints. Pulled out of barberController.js
 * (where escapeRegex and readPaging first appeared) once the admin
 * controllers needed the exact same two functions -- see the comments on
 * each for what they protect against.
 */

/**
 * Makes a user-supplied string safe to put inside a regular expression.
 *
 * WHY THIS IS NEEDED:
 * Searching with  new RegExp(req.query.q)  lets the visitor send regex
 * syntax straight into your database query. At best they get odd results;
 * at worst they send a pattern like  (a+)+$  which can make the server burn
 * CPU for a very long time on a short input -- a real denial-of-service
 * technique called ReDoS.
 *
 * Escaping every special character means the input can only ever be
 * treated as plain text to match.
 */
const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Reads page and limit from the query string safely.
 * The cap matters: without it, someone requests ?limit=1000000 and the
 * server tries to load and serialise the entire collection.
 */
const readPaging = (query, { defaultLimit = 20, maxLimit = 100 } = {}) => {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const requested = Number.parseInt(query.limit, 10) || defaultLimit;
  const limit = Math.min(maxLimit, Math.max(1, requested));
  return { page, limit, skip: (page - 1) * limit };
};

module.exports = { escapeRegex, readPaging };
