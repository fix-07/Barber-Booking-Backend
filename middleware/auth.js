const User = require("../models/User");
const { COOKIE_NAME, verifyToken, readCookie } = require("../utils/token");

/**
 * requireAuth: "you must be logged in to continue".
 *
 * Steps:
 *  1. Find the token (cookie first, then Authorization header for Postman).
 *  2. Verify the signature. A forged or expired token fails here.
 *  3. Load the user fresh from the database.
 *  4. Attach the REAL user to req.user.
 *
 * THE MOST IMPORTANT RULE IN THIS FILE:
 * Every later check of "who am I" and "is this mine" must use req.user,
 * which comes from this verified token. Never use an id sent in the
 * request body, query string or URL to decide ownership, because anyone
 * can type any id they like into a request.
 */
const requireAuth = async (req, res, next) => {
  try {
    let token = readCookie(req, COOKIE_NAME);

    // Fallback so you can test the API with curl or Postman.
    if (!token) {
      const header = req.headers.authorization || "";
      if (header.startsWith("Bearer ")) token = header.slice(7).trim();
    }

    if (!token) {
      return res.status(401).json({ message: "You must be logged in." });
    }

    const payload = verifyToken(token);

    // Load the user. Step 3 matters: a token for a deleted account
    // must stop working.
    const user = await User.findById(payload.id);
    if (!user) {
      return res
        .status(401)
        .json({ message: "This account no longer exists. Please log in again." });
    }

    req.user = user;
    next();
  } catch (error) {
    // jwt.verify throws for tampered tokens and for expired ones.
    // We give the same vague message either way and do not echo the error,
    // so we never hand an attacker debugging help.
    if (error.name === "TokenExpiredError") {
      return res
        .status(401)
        .json({ message: "Your session has expired. Please log in again." });
    }
    return res.status(401).json({ message: "Invalid session. Please log in again." });
  }
};

/**
 * requireRole: "you must be one of these roles to continue".
 *
 * Use it AFTER requireAuth, for example:
 *   router.get("/admin/users", requireAuth, requireRole("admin"), handler)
 *
 * WHY THIS LIVES ON THE SERVER:
 * Hiding an admin link in React hides nothing. Anyone can open the browser
 * devtools or call the API directly with curl. The only real protection is
 * this check, on the backend, on every protected route.
 */
const requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "You must be logged in." });
    }

    if (!allowedRoles.includes(req.user.role)) {
      // 403 means "we know who you are, you are just not allowed".
      return res
        .status(403)
        .json({ message: "You do not have permission to do this." });
    }

    next();
  };
};

/**
 * requireActiveBarber: blocks a barber whose account is not yet approved
 * (or has been rejected/suspended) from every protected barber-dashboard
 * request -- profile, services, appointments.
 *
 * WHY THIS IS SEPARATE FROM requireRole("barber"):
 * requireRole only checks WHO you are; this checks whether that barber
 * account is currently allowed to operate. Use both, in this order:
 *   router.get("/me", requireAuth, requireRole("barber"), requireActiveBarber, handler)
 *
 * SECURITY NOTE (this is the control the spec calls out by name):
 * "Never allow barber to bypass approval by directly visiting dashboard
 * URL." Hiding a link in the React sidebar hides nothing -- this check runs
 * on the server, on every request, regardless of what the browser shows.
 *
 * Only ever applied after requireRole("barber"), so req.user.role is
 * guaranteed to be "barber" here -- a customer or admin never reaches this
 * middleware at all.
 */
const requireActiveBarber = (req, res, next) => {
  if (req.user.status !== "active") {
    const messages = {
      pending_approval:
        "Your application has been submitted. Your account is waiting for VEYRON admin approval.",
      rejected: "Your barber application was not approved.",
      suspended: "Your account has been suspended. Contact VEYRON for details.",
    };

    return res.status(403).json({
      message: messages[req.user.status] || "Your account cannot access the barber dashboard right now.",
      barberStatus: req.user.status,
    });
  }

  next();
};

/**
 * requireActiveCustomer: blocks a suspended CUSTOMER from booking-related
 * requests even if they still hold a valid session cookie from before the
 * suspension. Login itself is already refused for a suspended customer
 * (see authController.login) -- this covers the case where they were
 * already logged in when an admin suspended them.
 *
 * Only ever applied after requireRole("customer"), so req.user.role is
 * guaranteed to be "customer" here.
 */
const requireActiveCustomer = (req, res, next) => {
  if (req.user.status === "suspended") {
    return res.status(403).json({
      message: "Your account has been suspended. Contact VEYRON for details.",
      accountStatus: req.user.status,
    });
  }

  next();
};

module.exports = { requireAuth, requireRole, requireActiveBarber, requireActiveCustomer };
