const express = require("express");
const { body } = require("express-validator");

const { register, login, logout, getMe } = require("../controllers/authController");
const {
  sendVerification,
  verifyAccount,
  forgotPassword,
  resetPassword,
} = require("../controllers/verificationController");
const {
  verifyRegistration,
  resendRegistrationCode,
} = require("../controllers/pendingRegistrationController");
const { googleSignIn, completeProfile } = require("../controllers/googleAuthController");
const { requireAuth } = require("../middleware/auth");
const validate = require("../middleware/validate");
const {
  authLimiter,
  verificationRequestLimiter,
  verificationAttemptLimiter,
} = require("../middleware/rateLimit");
const { isValidTimeZone } = require("../utils/schedule");

const router = express.Router();

/**
 * VALIDATION RULES
 *
 * express-validator was already in your package.json but unused. These
 * rules run before the controller. They do two jobs:
 *   1. Reject rubbish early with a clear message per field.
 *   2. Force each value to be the right TYPE. That second job is a real
 *      security control: .isString() stops someone sending
 *      { "email": { "$ne": null } } to bypass the login check.
 */

const registerRules = [
  body("name")
    .isString().withMessage("Name is required.")
    .trim()
    .isLength({ min: 2, max: 60 })
    .withMessage("Name must be between 2 and 60 characters."),

  body("email")
    .isString().withMessage("Email is required.")
    .trim()
    .isEmail().withMessage("Enter a valid email address.")
    .isLength({ max: 254 }).withMessage("Email is too long.")
    .normalizeEmail({ gmail_remove_dots: false }),

  body("password")
    .isString().withMessage("Password is required.")
    // The 72 limit is not arbitrary: bcrypt only looks at the first 72
    // bytes, so a longer password would be silently cut short. Rejecting
    // it is more honest than pretending to use all of it.
    .isLength({ min: 8, max: 72 })
    .withMessage("Password must be between 8 and 72 characters."),

  // REQUIRED. See the matching comment in models/User.js for why. All four
  // places that describe this field -- here, the model, the register form
  // and the Privacy Policy -- must agree.
  body("phone")
    .isString().withMessage("Phone number is required.")
    .trim()
    .isLength({ min: 1 }).withMessage("Phone number is required.")
    .isLength({ max: 30 }).withMessage("Phone number is too long.")
    .matches(/^[0-9+()\-\s]+$/)
    .withMessage("Phone number may only contain digits, spaces, + ( ) and -."),

  body("role")
    .optional({ values: "falsy" })
    .isIn(["customer", "barber"])
    .withMessage("Choose either customer or barber."),

  body("acceptedPolicies")
    .isBoolean().withMessage("Please confirm you have read the Privacy Policy and Terms.")
    .toBoolean(),

  /**
   * BARBER APPLICATION FIELDS.
   *
   * Only required when role === "barber" -- a customer signup never sends
   * these and must not be asked to. Shape matches BarberProfile's schema
   * (see models/BarberProfile.js), since these values are saved straight
   * into a BarberProfile document in authController.register.
   */
  body("shopName")
    .if(body("role").equals("barber"))
    .isString().withMessage("Shop or business name is required.")
    .trim()
    .isLength({ min: 2, max: 80 })
    .withMessage("Shop name must be between 2 and 80 characters."),

  body("city")
    .if(body("role").equals("barber"))
    .isString().withMessage("City or town is required.")
    .trim()
    .isLength({ min: 2, max: 80 })
    .withMessage("City must be between 2 and 80 characters."),

  body("region")
    .optional({ values: "falsy" })
    .isString().trim().isLength({ max: 80 })
    .withMessage("Region cannot be longer than 80 characters."),

  body("country")
    .optional({ values: "falsy" })
    .isString().trim().isLength({ max: 80 })
    .withMessage("Country cannot be longer than 80 characters."),

  body("addressLine")
    .optional({ values: "falsy" })
    .isString().trim().isLength({ max: 160 })
    .withMessage("Address cannot be longer than 160 characters."),

  body("latitude")
    .optional()
    .isFloat({ min: -90, max: 90 }).withMessage("Latitude must be between -90 and 90.")
    .toFloat(),

  body("longitude")
    .optional()
    .isFloat({ min: -180, max: 180 }).withMessage("Longitude must be between -180 and 180.")
    .toFloat(),

  body("locationConfirmed")
    .optional()
    .isBoolean().withMessage("locationConfirmed must be true or false.")
    .toBoolean(),

  body("timeZone")
    .if(body("role").equals("barber"))
    .isString().withMessage("Shop timezone is required.")
    .trim()
    .custom(isValidTimeZone)
    .withMessage("Choose a timezone such as Europe/London or America/New_York."),

  body("bio")
    .optional({ values: "falsy" })
    .isString().trim().isLength({ max: 600 })
    .withMessage("Description cannot be longer than 600 characters."),

  body("experience")
    .optional({ values: "falsy" })
    .isString().trim().isLength({ max: 500 })
    .withMessage("Experience cannot be longer than 500 characters."),

  body("photoUrl")
    .optional({ values: "falsy" })
    .isString().trim().isLength({ max: 2000 })
    .withMessage("Photo link is too long."),

  body("specialties")
    .optional()
    .isArray({ max: 10 }).withMessage("Up to 10 specialties."),
  body("specialties.*")
    .optional()
    .isString().trim().isLength({ min: 1, max: 40 })
    .withMessage("Each specialty must be 40 characters or fewer."),

  body("requestedServices")
    .optional()
    .isArray({ max: 10 }).withMessage("Up to 10 requested services."),
  body("requestedServices.*")
    .optional()
    .isString().trim().isLength({ min: 1, max: 80 })
    .withMessage("Each requested service must be 80 characters or fewer."),
];

const loginRules = [
  body("email")
    .isString().withMessage("Email is required.")
    .trim()
    .isEmail().withMessage("Enter a valid email address.")
    .normalizeEmail({ gmail_remove_dots: false }),

  body("password")
    .isString().withMessage("Password is required.")
    .isLength({ min: 1 }).withMessage("Password is required."),

  // Optional, and coerced to a real boolean so a string "false" from a
  // hand-made request cannot come through as truthy.
  body("rememberMe")
    .optional()
    .isBoolean().withMessage("rememberMe must be true or false.")
    .toBoolean(),
];

/**
 * A submitted verification code.
 *
 * .isString() first matters as much here as it does on login: without it,
 * a caller could send { "code": { "$ne": null } } and reach code that was
 * written expecting a string.
 */
const codeRules = [
  body("code")
    .isString().withMessage("Enter the 6-digit code.")
    .trim()
    .matches(/^\d{6}$/)
    .withMessage("The code is 6 digits."),
];

const emailRule = [
  body("email")
    .isString().withMessage("Email is required.")
    .trim()
    .isEmail().withMessage("Enter a valid email address.")
    .normalizeEmail({ gmail_remove_dots: false }),
];

/**
 * The new password set at the end of a reset.
 *
 * Same 8-72 range as registration -- 72 because bcrypt ignores anything
 * past 72 bytes, so accepting more would silently truncate it. The
 * composition rules (upper, lower, number, symbol) are enforced in the
 * browser by the shared strength checker; this is the floor the server
 * insists on regardless of what the browser did.
 */
const newPasswordRule = [
  body("password")
    .isString().withMessage("Password is required.")
    .isLength({ min: 8, max: 72 })
    .withMessage("Password must be between 8 and 72 characters."),
];

const googleTokenRule = [
  body("idToken")
    .isString().withMessage("Missing Google sign-in token.")
    .isLength({ min: 1, max: 4096 })
    .withMessage("Malformed Google sign-in token."),

  // Optional here (an existing account signing back in sends nothing, and
  // that is fine -- see googleAuthController.js). When present it must be
  // a real boolean, so a hand-made request cannot pass a truthy-looking
  // string past the controller's own strict `=== true` check.
  body("acceptedPolicies")
    .optional()
    .isBoolean().withMessage("acceptedPolicies must be true or false.")
    .toBoolean(),
];

// Same character set as the phone rule in registerRules -- kept identical
// on purpose so a number accepted here would also have been accepted at
// signup, and vice versa.
const phoneRule = [
  body("phone")
    .isString().withMessage("Phone number is required.")
    .trim()
    .isLength({ min: 1 }).withMessage("Phone number is required.")
    .isLength({ max: 30 }).withMessage("Phone number is too long.")
    .matches(/^[0-9+()\-\s]+$/)
    .withMessage("Phone number may only contain digits, spaces, + ( ) and -."),
];

/**
 * ROUTES
 *
 * authLimiter is applied to register and login because those are the two
 * endpoints worth attacking with automated guessing.
 *
 * Express 5 automatically passes errors from an async handler to our
 * error middleware, so these controllers need no try/catch.
 */
router.post("/register", authLimiter, registerRules, validate, register);
router.post("/login", authLimiter, loginRules, validate, login);
router.post("/logout", logout);
router.get("/me", requireAuth, getMe);

/**
 * COMPLETING A PENDING REGISTRATION
 *
 * Public, unlike the pair below -- there is no account to be logged into
 * yet. POST /register creates a PendingRegistration, not a User (see
 * pendingRegistrationController.js); these are how that gets turned into a
 * real, verified account, or abandoned safely if the code is never
 * entered.
 */
router.post(
  "/verify-registration",
  verificationAttemptLimiter,
  [...emailRule, ...codeRules],
  validate,
  verifyRegistration
);

router.post(
  "/resend-registration-code",
  verificationRequestLimiter,
  emailRule,
  validate,
  resendRegistrationCode
);

/**
 * ACCOUNT VERIFICATION (for an account that already exists)
 *
 * Both require a login. This is for the small set of accounts that are
 * real but unverified -- chiefly one an admin created directly (see
 * adminBarberController.createBarber), which never goes through the
 * pending-registration flow above. A self-registered account is always
 * emailVerified by the time it exists at all, so it never needs these.
 *
 * The code is sent to the address on the logged-in account -- these
 * endpoints take no email parameter, so they cannot be used to send mail
 * to an address the caller merely typed.
 *
 * "Resend" is the same endpoint as "send": issuing a code already
 * invalidates the previous one, and the 60-second cooldown is enforced
 * inside the controller, so a separate resend route would be the same code
 * with a different name and one more thing to keep in step.
 */
router.post(
  "/send-verification",
  requireAuth,
  verificationRequestLimiter,
  sendVerification
);

router.post(
  "/verify-account",
  requireAuth,
  verificationAttemptLimiter,
  codeRules,
  validate,
  verifyAccount
);

/**
 * PASSWORD RESET
 *
 * Public by necessity: someone who cannot log in is exactly who needs
 * these. forgotPassword replies identically whether or not the account
 * exists -- see the comment on it for why that matters.
 */
router.post(
  "/forgot-password",
  verificationRequestLimiter,
  emailRule,
  validate,
  forgotPassword
);

router.post(
  "/reset-password",
  verificationAttemptLimiter,
  [...emailRule, ...codeRules, ...newPasswordRule],
  validate,
  resetPassword
);

/**
 * GOOGLE SIGN-IN
 *
 * Public: this IS how someone with no session gets one. Rate-limited the
 * same as register/login -- it is exactly as attackable (someone could
 * hammer it with garbage tokens), even though a garbage token can never
 * succeed. See controllers/googleAuthController.js for the account-linking
 * and always-role-customer rules.
 */
router.post("/google", authLimiter, googleTokenRule, validate, googleSignIn);

/**
 * The one-field screen a brand-new Google account is sent to. Auth-gated:
 * fills in the CALLER's own phone, from their own verified session, never
 * an id in the URL.
 */
router.patch("/complete-profile", requireAuth, phoneRule, validate, completeProfile);

module.exports = router;
