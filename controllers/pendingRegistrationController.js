const bcrypt = require("bcryptjs");

const User = require("../models/User");
const BarberProfile = require("../models/BarberProfile");
const PendingRegistration = require("../models/PendingRegistration");
const { sendMail } = require("../utils/mailer");
const {
  notifyEmailVerified,
  notifyBarberApplicationReceived,
  notifyAdminNewBarberApplication,
} = require("../services/notificationService");
const {
  generateCode,
  maskEmail,
  sendSession,
} = require("./verificationController");

const CODE_TTL_MINUTES = 10;
const RESEND_COOLDOWN_SECONDS = 60;
const PASSWORD_HASH_ROUNDS = 12; // matches models/User.js's own pre-save cost

/**
 * Turns a signup submission into an emailed code, without creating an
 * account. See models/PendingRegistration.js for why this exists.
 *
 * Called from authController.register AFTER it has already checked
 * acceptedPolicies and resolved the safe role -- this function trusts both
 * were already done.
 */
const beginRegistration = async (req, res, safeRole) => {
  const {
    name, email, password, phone,
    shopName, city, region, country, addressLine, latitude, longitude, locationConfirmed,
    timeZone, bio, experience, specialties, requestedServices, photoUrl,
  } = req.body;

  const normalizedEmail = String(email).toLowerCase();

  // A REAL account with this email already exists. Telling the person so
  // is the same tradeoff register has always made -- see the comment this
  // check used to carry in authController.js: the alternative is a
  // confusing dead end for someone who genuinely already has an account.
  const existingUser = await User.findOne({ email: normalizedEmail });
  if (existingUser) {
    return res.status(409).json({
      message: "Please correct the highlighted fields.",
      errors: { email: "An account with this email already exists." },
    });
  }

  // Hashed HERE, once, and never held in plain text anywhere -- see the
  // header comment on models/PendingRegistration.js.
  const passwordHash = await bcrypt.hash(password, PASSWORD_HASH_ROUNDS);

  const plainCode = generateCode();
  const codeHash = await bcrypt.hash(plainCode, 10);
  const now = new Date();

  const document = {
    email: normalizedEmail,
    name,
    passwordHash,
    phone,
    role: safeRole,
    acceptedPolicies: true,
    acceptedPoliciesAt: now,
    shopName: safeRole === "barber" ? shopName : "",
    city: safeRole === "barber" ? city : "",
    region: safeRole === "barber" ? region || "" : "",
    country: safeRole === "barber" ? country || "" : "",
    addressLine: safeRole === "barber" ? addressLine || "" : "",
    // Same "confirmed pair, or nothing" rule as the profile editor -- see
    // the pre("validate") hook on models/BarberProfile.js, which this
    // mirrors so a signup can never create a profile with a half-saved
    // or falsely-confirmed location that upsertMyBarberProfile itself
    // would refuse to save.
    latitude:
      safeRole === "barber" && locationConfirmed === true && Number.isFinite(latitude)
        ? latitude
        : null,
    longitude:
      safeRole === "barber" && locationConfirmed === true && Number.isFinite(longitude)
        ? longitude
        : null,
    locationConfirmed:
      safeRole === "barber" && locationConfirmed === true && Number.isFinite(latitude) && Number.isFinite(longitude),
    timeZone: safeRole === "barber" ? timeZone : "",
    bio: safeRole === "barber" ? bio || "" : "",
    experience: safeRole === "barber" ? experience || "" : "",
    specialties:
      safeRole === "barber" && Array.isArray(specialties) ? specialties : [],
    requestedServices:
      safeRole === "barber" && Array.isArray(requestedServices)
        ? requestedServices
        : [],
    photoUrl: safeRole === "barber" ? photoUrl || "" : "",
    codeHash,
    codeIssuedAt: now,
    expiresAt: new Date(now.getTime() + CODE_TTL_MINUTES * 60 * 1000),
    attempts: 0,
  };

  /**
   * A second attempt at the same email REPLACES the first, rather than
   * being refused. That is deliberately how "I didn't get the code, let me
   * try again" and "I mistyped something, let me redo the form" both work
   * here: the old attempt (and its now-superseded code) simply stops being
   * the live one.
   */
  await PendingRegistration.findOneAndDelete({ email: normalizedEmail });

  try {
    await PendingRegistration.create(document);
  } catch (error) {
    // The unique index on email is the only realistic way this throws --
    // two identical submissions landing in the same instant. Treat it as
    // "please try again" rather than a 500.
    if (error.code === 11000) {
      return res.status(409).json({
        message: "That email is already partway through signing up. Please try again in a moment.",
      });
    }
    throw error;
  }

  await sendMail({
    to: normalizedEmail,
    subject: "Your VEYRON verification code",
    text: [
      `Hello ${name},`,
      "",
      "Use this code to finish creating your VEYRON account.",
      "",
      `    ${plainCode}`,
      "",
      `This code expires in ${CODE_TTL_MINUTES} minutes. Until it is entered, no account has been created.`,
      "If you did not request this, you can ignore this email -- nothing will happen.",
      "",
      "VEYRON",
    ].join("\n"),
  });

  res.status(201).json({
    message: "Check your email to finish creating your account.",
    pendingEmail: normalizedEmail,
    verification: {
      sentTo: maskEmail(normalizedEmail),
      expiresInMinutes: CODE_TTL_MINUTES,
      resendAfterSeconds: RESEND_COOLDOWN_SECONDS,
    },
  });
};

/**
 * POST /api/auth/verify-registration
 * Body: { email, code }
 *
 * The ONLY place a User document gets created for a self-registered
 * account. Everything up to here has been provisional.
 */
const verifyRegistration = async (req, res) => {
  const { email, code } = req.body;
  const normalizedEmail = String(email).toLowerCase();

  const invalidCode = () =>
    res.status(400).json({
      message: "That code is no longer valid. Please register again.",
      errors: { code: "This code has expired, been used too many times, or never existed." },
    });

  const pending = await PendingRegistration.findOne({ email: normalizedEmail })
    .select("+codeHash +passwordHash");

  if (!pending || !pending.isLive()) return invalidCode();

  const matches = await pending.compareCode(code);
  if (!matches) {
    pending.attempts += 1;
    await pending.save();

    const attemptsLeft = Math.max(
      PendingRegistration.MAX_ATTEMPTS - pending.attempts,
      0
    );

    return res.status(400).json({
      message: "That code is not correct.",
      errors: {
        code:
          attemptsLeft > 0
            ? `That code is not correct. ${attemptsLeft} ${attemptsLeft === 1 ? "attempt" : "attempts"} remaining.`
            : "Too many incorrect attempts. Please register again.",
      },
      attemptsRemaining: attemptsLeft,
    });
  }

  /**
   * RACE GUARD: something else created a real account with this email in
   * the window between the code being emailed and it being entered (the
   * only realistic cause is the person completing this exact flow twice
   * in two tabs). Whichever request gets here first wins; this one loses
   * cleanly rather than throwing a duplicate-key error.
   */
  const alreadyExists = await User.findOne({ email: normalizedEmail });
  if (alreadyExists) {
    await pending.deleteOne();
    return res.status(409).json({
      message: "This email already has an account. Please sign in instead.",
    });
  }

  const user = new User({
    name: pending.name,
    email: pending.email,
    phone: pending.phone,
    role: pending.role,
    status: pending.role === "barber" ? "pending_approval" : undefined,
    acceptedPolicies: pending.acceptedPolicies,
    acceptedPoliciesAt: pending.acceptedPoliciesAt,
    emailVerified: true, // the code they just entered IS the proof
  });

  // The password was hashed once already, when the PendingRegistration was
  // created -- see models/User.js for why this flag exists and what would
  // go wrong without it.
  user.password = pending.passwordHash;
  user.$locals.skipPasswordHashing = true;
  await user.save();

  // Same BarberProfile-as-application shape authController.register used
  // to create directly. Nothing about approval changes: still
  // "pending_approval", still unpublished, still invisible publicly until
  // an admin approves it.
  let profile = null;
  if (pending.role === "barber") {
    profile = await BarberProfile.create({
      user: user._id,
      shopName: pending.shopName,
      city: pending.city,
      region: pending.region,
      country: pending.country,
      addressLine: pending.addressLine,
      latitude: pending.latitude,
      longitude: pending.longitude,
      locationConfirmed: pending.locationConfirmed,
      timeZone: pending.timeZone,
      bio: pending.bio,
      experience: pending.experience,
      specialties: pending.specialties,
      requestedServices: pending.requestedServices,
      photoUrl: pending.photoUrl,
    });
  }

  await pending.deleteOne();

  /**
   * Notifications, AFTER the account genuinely exists.
   *
   * Wrapped so a notification failure can never turn a successful signup
   * into an error response -- the account is real either way; see
   * services/notificationService.js's own internal try/catch for how an
   * email failure specifically is handled (logged, recorded, never
   * thrown). This outer catch is only for something going wrong in the
   * notification code itself.
   */
  try {
    await notifyEmailVerified(user);

    if (pending.role === "barber") {
      // Two different messages: the barber is told their application was
      // received, admins are told there is something to review, with a
      // link straight to the queue -- see the spec's "admin must receive
      // an email containing a link to review the barber".
      await notifyBarberApplicationReceived(user);
      await notifyAdminNewBarberApplication(user, profile);
    }
  } catch (error) {
    console.error("Post-verification notifications failed:", error.message);
  }

  sendSession(res, user, 201, "Account created and verified.", false);
};

/**
 * POST /api/auth/resend-registration-code
 * Body: { email }
 */
const resendRegistrationCode = async (req, res) => {
  const { email } = req.body;
  const normalizedEmail = String(email).toLowerCase();

  const pending = await PendingRegistration.findOne({ email: normalizedEmail });

  /**
   * Unlike forgot-password, this is not a membership-oracle risk worth
   * hiding behind a vague reply: the person just typed this exact email
   * into the signup form themselves, seconds or minutes ago, so a direct
   * answer reveals nothing they do not already know. What it protects
   * against is a confusing silent failure if their pending attempt has
   * already expired.
   */
  if (!pending) {
    return res.status(404).json({
      message: "We couldn't find a signup in progress for that email. Please register again.",
    });
  }

  const secondsSinceIssued = (Date.now() - pending.codeIssuedAt.getTime()) / 1000;
  const wait = Math.ceil(RESEND_COOLDOWN_SECONDS - secondsSinceIssued);
  if (wait > 0) {
    return res.status(429).json({
      message: `Please wait ${wait} seconds before requesting another code.`,
      retryAfterSeconds: wait,
    });
  }

  const plainCode = generateCode();
  pending.codeHash = await bcrypt.hash(plainCode, 10);
  pending.codeIssuedAt = new Date();
  pending.expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000);
  pending.attempts = 0; // a fresh code deserves a fresh five attempts
  await pending.save();

  await sendMail({
    to: normalizedEmail,
    subject: "Your VEYRON verification code",
    text: [
      `Hello ${pending.name},`,
      "",
      "Use this code to finish creating your VEYRON account.",
      "",
      `    ${plainCode}`,
      "",
      `This code expires in ${CODE_TTL_MINUTES} minutes. Until it is entered, no account has been created.`,
      "If you did not request this, you can ignore this email -- nothing will happen.",
      "",
      "VEYRON",
    ].join("\n"),
  });

  res.status(200).json({
    message: "Verification code sent.",
    sentTo: maskEmail(normalizedEmail),
    expiresInMinutes: CODE_TTL_MINUTES,
    resendAfterSeconds: RESEND_COOLDOWN_SECONDS,
  });
};

module.exports = { beginRegistration, verifyRegistration, resendRegistrationCode };
