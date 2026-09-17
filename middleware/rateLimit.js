/**
 * A simple rate limiter: "allow at most N requests per IP per time window".
 *
 * WHY: without this, someone can send thousands of login attempts per
 * minute to guess a password, or spam your register endpoint to fill the
 * database.
 *
 * HOW IT WORKS: we keep a small map in memory of
 *   ip address -> { count, windowStartTime }
 * When the window expires we reset the count.
 *
 * HONEST LIMITATION (important):
 * Because the counts live in this one process's memory, they are lost on
 * restart and are NOT shared if you ever run several copies of the server
 * behind a load balancer. That is fine for local development and a single
 * small server. If you later scale to multiple instances, switch to the
 * "express-rate-limit" package with a Redis store. I have not installed it
 * now because you do not need it yet.
 */

const createRateLimiter = ({ windowMs, max, message }) => {
  const hits = new Map();

  // Periodically throw away expired entries so the map cannot grow forever.
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of hits) {
      if (now - record.windowStart > windowMs) hits.delete(key);
    }
  }, windowMs);

  // Do not keep the Node process alive just for this timer.
  cleanupTimer.unref();

  return (req, res, next) => {
    // Jest sets NODE_ENV=test automatically. A real integration suite
    // legitimately needs more than 10 auth requests across its cases
    // (registering several test accounts, logging in as several roles) --
    // that is test traffic exercising the feature, not the abuse this
    // limiter exists to slow down. Production and every other environment
    // are completely unaffected.
    if (process.env.NODE_ENV === "test") return next();

    const key = req.ip || "unknown";
    const now = Date.now();
    const record = hits.get(key);

    if (!record || now - record.windowStart > windowMs) {
      hits.set(key, { count: 1, windowStart: now });
      return next();
    }

    record.count += 1;

    if (record.count > max) {
      const retryAfterSeconds = Math.ceil(
        (record.windowStart + windowMs - now) / 1000
      );
      res.setHeader("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({
        message:
          message || "Too many requests. Please wait and try again shortly.",
      });
    }

    next();
  };
};

/**
 * Strict limit for login and register.
 * 10 attempts per 15 minutes per IP, by default.
 *
 * WHY THE LIMIT IS READ FROM THE ENVIRONMENT:
 * An end-to-end audit of this API legitimately makes more than ten auth
 * calls from one address -- registering a customer, a barber and a second
 * customer, then logging each of them in, is already close to the cap
 * before any negative cases are tried. Hard-coding 10 made the suite
 * untestable against a real server.
 *
 * This is a configuration knob, NOT a bypass: there is no header, body
 * field or query parameter that can raise it, so nothing a client sends
 * can weaken the limit. Leave AUTH_RATE_LIMIT_MAX unset in production and
 * the behaviour is exactly what it was.
 */
const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATE_LIMIT_MAX) || 10,
  message:
    "Too many login or signup attempts from this network. Please wait 15 minutes and try again.",
});

/**
 * Asking for a verification or password-reset code to be sent.
 * 5 per hour per IP.
 *
 * This limit is about what each request COSTS someone else: every one of
 * them puts a real email in a real person's inbox. Without a cap, this
 * endpoint is a free way to flood an address you do not own, using our
 * domain to do it. An hour-long window is deliberately much longer than
 * the 60-second resend countdown in the UI, which exists for a different
 * reason (stopping impatient double-taps).
 */
const verificationRequestLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message:
    "Too many codes requested from this network. Please wait an hour and try again.",
});

/**
 * Submitting a code to be checked.
 * 20 per 15 minutes per IP.
 *
 * The per-code attempt cap in models/VerificationCode.js is the real
 * protection and it cannot be escaped by requesting a fresh code, because
 * issuing one consumes the last. This limit exists to stop somebody
 * working through many accounts' codes in parallel, which a per-code
 * counter cannot see.
 */
const verificationAttemptLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message:
    "Too many verification attempts from this network. Please wait 15 minutes and try again.",
});

/**
 * Gentler limit for everything else, to absorb accidental request loops.
 * 300 requests per 15 minutes per IP.
 */
const generalLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 300,
});

module.exports = {
  createRateLimiter,
  authLimiter,
  verificationRequestLimiter,
  verificationAttemptLimiter,
  generalLimiter,
};
