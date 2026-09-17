/**
 * Adds standard security response headers.
 *
 * This is a small hand-written replacement for the "helmet" package.
 * We do it by hand so you can see exactly what each header does and so
 * the project keeps one less dependency.
 *
 * NOTE: these headers protect responses coming FROM THIS API.
 * Your React app is served by a different process (the dev server, or
 * your host in production), so it needs its own headers there.
 */
const securityHeaders = (req, res, next) => {
  // Stops the browser from guessing a file's type. Prevents a JSON
  // response from being treated as HTML and executed.
  res.setHeader("X-Content-Type-Options", "nosniff");

  // Stops other sites from loading this API inside an <iframe>,
  // which blocks clickjacking.
  res.setHeader("X-Frame-Options", "DENY");

  // Do not leak the full URL (which may contain ids) to other sites.
  res.setHeader("Referrer-Policy", "no-referrer");

  // This API has no pages, so forbid everything. If a response were ever
  // rendered as HTML, no scripts, styles or frames could run.
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
  );

  // Turn off browser features this API never needs.
  res.setHeader(
    "Permissions-Policy",
    "geolocation=(), camera=(), microphone=(), payment=()"
  );

  // Hide the fact that we run Express. Less information for an attacker.
  res.removeHeader("X-Powered-By");

  // Tell browsers to always use HTTPS for the next 180 days.
  // Only sent in production: switching this on over plain http://localhost
  // can make your browser refuse to load localhost later, which is very
  // confusing to undo.
  if (process.env.NODE_ENV === "production") {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=15552000; includeSubDomains"
    );
  }

  next();
};

module.exports = securityHeaders;
