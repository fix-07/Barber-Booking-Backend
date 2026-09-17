const User = require("../models/User");
const { verifyGoogleIdToken } = require("../utils/googleAuth");
const { sendSession } = require("./verificationController");

/**
 * "Sign in with Google" -- also, unavoidably, "Sign UP with Google": the
 * first time a given Google account is seen, this creates the account.
 * There is no separate signup endpoint for this path, the same way real
 * Google/Apple/GitHub sign-in buttons never ask "do you want to log in or
 * register?" first -- the button already answers that.
 *
 * ==========================================================================
 *  ALWAYS role: "customer", NEVER TRUST ANYTHING ELSE FROM THE CLIENT
 * ==========================================================================
 *
 * This endpoint takes exactly one input from the browser: the ID token.
 * There is no `role` field to trust or distrust, unlike POST /register --
 * a brand-new Google account is unconditionally a customer. A barber
 * still applies through the dedicated multi-step form (see
 * BarberSignupPage.js): that flow collects a shop name, city, specialties
 * and services an OAuth button has no way to ask for, and an admin account
 * can only ever be created directly in the database (see
 * authController.register's own comment on the same rule) -- this endpoint
 * enforces that by construction, not by checking a value, since it never
 * looks at anything the client could set it to.
 *
 * ==========================================================================
 *  LINKING BY EMAIL: A DELIBERATE, NOT ACCIDENTAL, CHOICE
 * ==========================================================================
 *
 * If someone already has a password-based VEYRON account and signs in with
 * a Google account sharing that same email, this treats them as the same
 * person and logs into the EXISTING account, rather than refusing or
 * creating a confusing second account with a duplicate email (which the
 * unique index on User.email would refuse anyway).
 *
 * This is safe specifically BECAUSE Google has already verified the
 * person controls that email address (checked below via emailVerified) --
 * the same standard of proof this app's own signup flow requires before
 * ever creating an account. It is also the standard behaviour of Google,
 * GitHub, and most real "Sign in with X" implementations, for the same
 * reason.
 */
const googleSignIn = async (req, res) => {
  const { idToken, acceptedPolicies } = req.body;

  let identity;
  try {
    identity = await verifyGoogleIdToken(idToken);
  } catch (error) {
    // An invalid, expired, or forged token is an expected outcome of a
    // public endpoint fed a client-supplied string -- 401, not a 500.
    return res.status(401).json({ message: "That Google sign-in could not be verified." });
  }

  if (!identity.emailVerified) {
    return res.status(401).json({
      message: "Your Google account's email address is not verified. Please verify it with Google first.",
    });
  }

  // 1. Already linked: the fast, common path for a returning user.
  let user = await User.findOne({ googleId: identity.googleId });

  // 2. Not linked yet, but the email matches an existing account -- link
  //    them (see the header comment for why this is safe).
  if (!user) {
    user = await User.findOne({ email: identity.email });
    if (user && !user.googleId) {
      user.googleId = identity.googleId;
      // Deliberately NOT overwriting authProvider if it is already
      // "local": that flag means "this account also has a password", and
      // linking Google on top should not make that password unusable.
      // (authProvider only ever governs what is REQUIRED at creation.)
      await user.save();
    }
  }

  // 3. Genuinely new: create the account. No PendingRegistration and no
  //    emailed code -- Google already proved control of the address,
  //    which is the exact thing that whole flow exists to establish for a
  //    typed-in email (see pendingRegistrationController.js).
  //
  //    ACTIVE CONSENT STILL APPLIES HERE. Google proves who someone is;
  //    it says nothing about whether they have read OUR Terms and Privacy
  //    Policy. Every other way an account gets created in this app --
  //    the classic register endpoint, the pending-registration flow --
  //    refuses without a genuinely ticked box (see authController.register's
  //    own comment on this). A Google sign-in creating an account for free,
  //    with no consent captured at all, would be the one silent exception
  //    to a rule the rest of the codebase treats as absolute. So: required
  //    for a NEW account, and irrelevant for signing into an EXISTING one
  //    (which already has its own acceptedPoliciesAt from however it was
  //    first created) -- exactly how login never re-asks for consent either.
  if (!user && acceptedPolicies !== true) {
    return res.status(400).json({
      message: "Please correct the highlighted fields.",
      errors: {
        acceptedPolicies:
          "Please confirm you have read the Privacy Policy and Terms.",
      },
    });
  }

  let isNewAccount = false;
  if (!user) {
    isNewAccount = true;
    user = await User.create({
      name: identity.name,
      email: identity.email,
      googleId: identity.googleId,
      authProvider: "google",
      role: "customer",
      emailVerified: true,
      acceptedPolicies: true,
      acceptedPoliciesAt: new Date(),
      // phone is intentionally absent: not required for authProvider
      // "google" (see models/User.js), filled in by completeProfile
      // below. bookingController.createBooking refuses to let this
      // account book until it is.
    });
  }

  if (user.status === "suspended") {
    return res.status(403).json({
      message: "Your account has been suspended. Contact VEYRON for details.",
    });
  }

  sendSession(res, user, isNewAccount ? 201 : 200, "Signed in with Google.", false);
};

/**
 * PATCH /api/auth/complete-profile
 * Body: { phone }
 *
 * The one-field screen a brand-new Google account is sent to before it can
 * do much else. Auth-gated: it fills in the CALLER's own phone number,
 * never one named in the URL or body for someone else.
 */
const completeProfile = async (req, res) => {
  const { phone } = req.body;

  req.user.phone = phone;
  await req.user.save();

  res.status(200).json({
    message: "Profile updated.",
    user: req.user.toPublicJSON(),
  });
};

module.exports = { googleSignIn, completeProfile };
