/**
 * Hand-written CORS middleware (we do NOT use the "cors" package).
 *
 * WHAT CORS IS, simply:
 * A browser will not let JavaScript on http://localhost:3000 read a
 * response from http://localhost:5000 unless the server says it is allowed.
 * These headers are that permission slip.
 *
 * WHY NOT cors() WITH NO OPTIONS:
 * The default allows EVERY website to call your API. Any page a logged-in
 * user visits could then talk to your backend. We allow only our own
 * frontend origin, read from the CLIENT_ORIGIN environment variable.
 */

// Build the allow-list once at startup.
const allowedOrigins = (process.env.CLIENT_ORIGIN || "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const corsMiddleware = (req, res, next) => {
  const requestOrigin = req.headers.origin;

  // Only echo back the origin if it is on our allow-list.
  // Echoing back whatever was sent would defeat the whole point.
  if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin);

    // Tells caches that the response depends on the Origin header,
    // so one origin's response is not served to another origin.
    res.setHeader("Vary", "Origin");

    // Required because the frontend sends the login cookie.
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }

  // A "preflight" is an automatic OPTIONS request the browser sends
  // before a POST/PUT/DELETE to ask permission. We answer and stop here.
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Max-Age", "600");
    return res.sendStatus(204);
  }

  next();
};

module.exports = corsMiddleware;
