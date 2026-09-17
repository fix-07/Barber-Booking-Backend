const bcrypt = require("bcryptjs");
const User = require("../models/User");
const { COOKIE_NAME, cookieOptions } = require("../utils/token");
const { sendSession } = require("./verificationController");
const { beginRegistration } = require("./pendingRegistrationController");
const { notifySuspiciousLogin } = require("../services/notificationService");

// After this many consecutive wrong passwords, the account holder gets an
// alert email. See notifySuspiciousLogin -- it is bucketed per hour, so a
// sustained attack still sends at most one alert per hour, not one per
// attempt.
const SUSPICIOUS_LOGIN_THRESHOLD = 5;

/**
 * A throwaway bcrypt hash of a random value.
 *
 * WHY THIS EXISTS: see the login function. If we skip bcrypt when an email
 * is not found, the "wrong email" reply comes back much faster than the
 * "wrong password" reply. An attacker can measure that difference to work
 * out which emails are registered. Comparing against this dummy hash makes
 * both paths take the same amount of time.
 */
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing-safety", 12);

/**
 * POST /api/auth/register
 *
 * ==========================================================================
 *  THIS DOES NOT CREATE AN ACCOUNT
 * ==========================================================================
 *
 * It used to: a User (and BarberProfile, for a barber) was created here,
 * immediately, before any code was checked. That meant an abandoned or
 * mistyped signup left a real account behind forever, permanently owning
 * that email address.
 *
 * Now this only validates the submission and hands off to
 * pendingRegistrationController.beginRegistration, which stores everything
 * in a PendingRegistration document (not a User) and emails a code. The
 * real account is created by verifyRegistration, in
 * controllers/pendingRegistrationController.js, and ONLY there -- if the
 * code is never entered correctly, PendingRegistration's own TTL index
 * deletes the attempt on its own and no account ever existed.
 *
 * The consent check and the privilege-escalation guard stay here, at the
 * front door, rather than moving into beginRegistration: they are about
 * whether this SUBMISSION is even acceptable, before anything is stored.
 */
const register = async (req, res) => {
  const { role, acceptedPolicies } = req.body;

  // ACTIVE CONSENT: the box must be genuinely ticked. It is not pre-checked
  // in the UI, and we refuse the signup if it is absent.
  if (acceptedPolicies !== true) {
    return res.status(400).json({
      message: "Please correct the highlighted fields.",
      errors: {
        acceptedPolicies:
          "Please confirm you have read the Privacy Policy and Terms.",
      },
    });
  }

  // PRIVILEGE ESCALATION GUARD:
  // We never trust a role sent by the browser. Someone could simply POST
  // { "role": "admin" }. Only these two roles can be chosen at signup;
  // anything else becomes "customer". Admin accounts must be promoted
  // directly in the database by you.
  const selfServiceRoles = ["customer", "barber"];
  const safeRole = selfServiceRoles.includes(role) ? role : "customer";

  await beginRegistration(req, res, safeRole);
};

/**
 * POST /api/auth/login
 */
const login = async (req, res) => {
  const { email, password, rememberMe } = req.body;

  // .select("+password") is required because the schema hides the password
  // field by default.
  const user = await User.findOne({
    email: String(email).toLowerCase(),
  }).select("+password");

  if (!user) {
    // Burn the same amount of time as a real password check would.
    await bcrypt.compare(String(password), DUMMY_HASH);
    return res
      .status(401)
      .json({ message: "Invalid email or password." });
  }

  const passwordMatches = await user.comparePassword(String(password));
  if (!passwordMatches) {
    // Tracked AFTER responding with the same generic 401 as always -- this
    // never changes what the caller sees, only what happens internally.
    user.failedLoginAttempts += 1;
    user.lastFailedLoginAt = new Date();
    await user.save();

    if (user.failedLoginAttempts >= SUSPICIOUS_LOGIN_THRESHOLD) {
      try {
        await notifySuspiciousLogin(user, user.failedLoginAttempts);
      } catch (error) {
        console.error("Suspicious-login notification failed:", error.message);
      }
    }

    // The SAME message as above, on purpose. If we said "wrong password"
    // here, we would be confirming that the email exists.
    return res
      .status(401)
      .json({ message: "Invalid email or password." });
  }

  // A genuine successful login clears the counter -- this is an alert
  // signal, not a lockout, so getting the password right always works.
  if (user.failedLoginAttempts > 0) {
    user.failedLoginAttempts = 0;
    user.lastFailedLoginAt = null;
    await user.save();
  }

  // A suspended CLIENT cannot log in at all -- unlike a suspended barber,
  // who still needs to log in to see why on their status page (see
  // BarberStatusPage.js and requireActiveBarber in middleware/auth.js,
  // which gates the barber dashboard itself rather than login). Customers
  // have no equivalent status page, so the block belongs here instead.
  if (user.role === "customer" && user.status === "suspended") {
    return res.status(403).json({
      message: "Your account has been suspended. Contact VEYRON for details.",
    });
  }

  // "Remember me" lengthens the session. It is read from the request but
  // never trusted for anything else -- it cannot change who you are, only
  // how long you stay signed in. See sendSession in verificationController.
  sendSession(res, user, 200, "Logged in successfully.", rememberMe === true);
};

/**
 * POST /api/auth/logout
 *
 * Because the cookie is httpOnly, the browser's JavaScript cannot delete
 * it. The server has to clear it, which is what this route is for.
 */
const logout = (req, res) => {
  const options = cookieOptions();
  delete options.maxAge; // clearCookie must not carry an expiry

  res.clearCookie(COOKIE_NAME, options);
  res.status(200).json({ message: "Logged out successfully." });
};

/**
 * GET /api/auth/me
 *
 * Lets the React app ask "am I still logged in, and who am I?" after a
 * page refresh. Since the token lives in an httpOnly cookie, this route is
 * the only way the frontend can find out.
 *
 * req.user was set by requireAuth from the VERIFIED token.
 */
const getMe = (req, res) => {
  res.status(200).json({ user: req.user.toPublicJSON() });
};

module.exports = { register, login, logout, getMe };
