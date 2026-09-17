const jwt = require("jsonwebtoken");

const COOKIE_NAME = "token";

/**
 * Creates a signed login token for a user.
 *
 * We put ONLY the user id inside the token. We deliberately do NOT put
 * the role inside it, because a token lasts for days: if you demoted
 * someone from barber to customer, an old token would still claim the
 * old role. Instead we look the user up in the database on every request,
 * so the role is always current.
 */
const signToken = (userId, expiresIn) => {
  return jwt.sign({ id: String(userId) }, process.env.JWT_SECRET, {
    expiresIn: expiresIn || process.env.JWT_EXPIRES_IN || "7d",
  });
};

/**
 * Checks a token's signature and expiry. Throws if invalid.
 */
const verifyToken = (token) => {
  return jwt.verify(token, process.env.JWT_SECRET);
};

/**
 * Converts values like "7d", "12h", "30m" into milliseconds,
 * so the cookie expires at the same time as the token inside it.
 */
const expiresInToMs = (value) => {
  const match = /^(\d+)([smhd])$/.exec(String(value || "").trim());
  if (!match) return 7 * 24 * 60 * 60 * 1000; // fall back to 7 days
  const amount = Number(match[1]);
  const unitMs = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]];
  return amount * unitMs;
};

/**
 * Settings for the login cookie.
 *
 * httpOnly: true   -> JavaScript in the browser CANNOT read this cookie.
 *                     This is the key protection: if your site ever has an
 *                     XSS bug, the attacker still cannot steal the token.
 *                     (Storing tokens in localStorage gives up this
 *                     protection, which is why we do not do that.)
 * sameSite: "lax"  -> the browser will not send this cookie when another
 *                     website makes a request to your API, which blocks
 *                     most CSRF attacks.
 * secure           -> only send over HTTPS. Off in development because
 *                     localhost is plain http.
 */
const cookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
  maxAge: expiresInToMs(process.env.JWT_EXPIRES_IN || "7d"),
});

/**
 * Reads a single cookie out of the raw Cookie header.
 * Written by hand so we do not need the "cookie-parser" package.
 */
const readCookie = (req, name) => {
  const header = req.headers.cookie;
  if (!header) return null;

  for (const part of header.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = part.slice(0, separatorIndex).trim();
    if (key !== name) continue;

    try {
      return decodeURIComponent(part.slice(separatorIndex + 1).trim());
    } catch {
      return null; // malformed cookie, treat as absent
    }
  }
  return null;
};

module.exports = {
  COOKIE_NAME,
  signToken,
  verifyToken,
  cookieOptions,
  readCookie,
};
