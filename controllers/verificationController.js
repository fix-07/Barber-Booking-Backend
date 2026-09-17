const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const User = require("../models/User");
const VerificationCode = require("../models/VerificationCode");
const { sendMail } = require("../utils/mailer");
const { COOKIE_NAME, signToken, cookieOptions } = require("../utils/token");
const { notifyEmailVerified, notifyPasswordChanged } = require("../services/notificationService");

const {
  CODE_TTL_MINUTES,
  MAX_ATTEMPTS,
  RESEND_COOLDOWN_SECONDS,
} = VerificationCode;

/**
 * Account verification and password reset.
 *
 * ==========================================================================
 *  THE RULE THIS WHOLE FILE IS BUILT AROUND
 * ==========================================================================
 *
 * A code is never returned to the caller. Not in a success response, not in
 * an error, not in development, not "just for testing". Every response here
 * says only whether the operation succeeded. The only place a plain code
 * exists is between generateCode() and the mailer, in memory, for the
 * length of one function call.
 *
 * The second rule, which shapes forgotPassword in particular: a public
 * endpoint must not become a way to ask "does this person have an account
 * here?". See the comment on that function.
 */

/**
 * A 6-digit code from a cryptographically secure source.
 *
 * crypto.randomInt, not Math.random. Math.random is seeded predictably and
 * is not meant for anything security-related -- given a few outputs you can
 * often predict the next. That is precisely the attack this code must
 * survive.
 *
 * randomInt(0, 1000000) is uniform across the whole range, so padStart is
 * what allows "000042" to be a legitimate code rather than something that
 * can never occur.
 */
const generateCode = () =>
  String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

/**
 * Issues a fresh code for one user and purpose, and emails it.
 *
 * Consuming the previous code first is a security property, not tidiness:
 * without it every resend would leave another live code in play, and a
 * handful of resends would turn one guessable code into several.
 */
const issueCode = async (user, purpose) => {
  await VerificationCode.updateMany(
    { user: user._id, purpose, consumedAt: null },
    { $set: { consumedAt: new Date() } }
  );

  const plainCode = generateCode();
  const codeHash = await bcrypt.hash(plainCode, 10);

  const record = await VerificationCode.create({
    user: user._id,
    purpose,
    codeHash,
    expiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000),
  });

  const subject =
    purpose === "password_reset"
      ? "Your VEYRON password reset code"
      : "Your VEYRON verification code";

  const intro =
    purpose === "password_reset"
      ? "Use this code to set a new password for your VEYRON account."
      : "Use this code to finish setting up your VEYRON account.";

  await sendMail({
    to: user.email,
    subject,
    text: [
      `Hello ${user.name},`,
      "",
      intro,
      "",
      `    ${plainCode}`,
      "",
      `This code expires in ${CODE_TTL_MINUTES} minutes and can be used once.`,
      "If you did not request it, you can ignore this email — nothing will change.",
      "",
      "VEYRON",
    ].join("\n"),
  });

  // The plain code goes out of scope here and is never persisted, logged,
  // or returned. Only `record` (which holds the hash) survives.
  return record;
};

/**
 * How long the caller must still wait before another code may be sent.
 * Returns 0 when they may send now.
 *
 * Enforced here rather than trusted from the countdown in the UI, which
 * anyone can skip past by reloading the page.
 */
const secondsUntilResendAllowed = async (user, purpose) => {
  const latest = await VerificationCode.findOne({ user: user._id, purpose })
    .sort({ createdAt: -1 })
    .select("createdAt");

  if (!latest) return 0;

  const elapsed = (Date.now() - latest.createdAt.getTime()) / 1000;
  const remaining = Math.ceil(RESEND_COOLDOWN_SECONDS - elapsed);
  return remaining > 0 ? remaining : 0;
};

/**
 * Hides most of an email address, for the "we sent a code to ..." line.
 *
 * The person reading it already knows their own address, so showing enough
 * to recognise it is useful. Showing all of it on a screen someone else
 * might be looking at is not.
 *
 *   alexander@example.com -> al•••••••@example.com
 *   jo@example.com        -> j•@example.com
 */
const maskEmail = (email) => {
  const [local, domain] = String(email).split("@");
  if (!domain) return "•••";

  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}${"•".repeat(Math.max(local.length - visible.length, 1))}@${domain}`;
};

/* ==========================================================================
   ACCOUNT VERIFICATION
   ========================================================================== */

/**
 * POST /api/auth/send-verification   (requires login)
 *
 * Sends a code to the logged-in user's own email. There is no email
 * parameter on purpose: taking one would let a logged-in person send mail
 * to any address they typed.
 */
const sendVerification = async (req, res) => {
  const user = req.user;

  if (user.emailVerified) {
    return res.status(200).json({
      message: "Your account is already verified.",
      alreadyVerified: true,
    });
  }

  const wait = await secondsUntilResendAllowed(user, "account_verification");
  if (wait > 0) {
    return res.status(429).json({
      message: `Please wait ${wait} seconds before requesting another code.`,
      retryAfterSeconds: wait,
    });
  }

  await issueCode(user, "account_verification");

  res.status(200).json({
    message: "Verification code sent.",
    sentTo: maskEmail(user.email),
    expiresInMinutes: CODE_TTL_MINUTES,
    resendAfterSeconds: RESEND_COOLDOWN_SECONDS,
  });
};

/**
 * POST /api/auth/verify-account   (requires login)
 * Body: { code }
 */
const verifyAccount = async (req, res) => {
  const user = req.user;
  const { code } = req.body;

  if (user.emailVerified) {
    return res
      .status(200)
      .json({ message: "Your account is already verified.", verified: true });
  }

  const record = await VerificationCode.findOne({
    user: user._id,
    purpose: "account_verification",
  })
    .sort({ createdAt: -1 })
    .select("+codeHash");

  // Deliberately the same message for "never asked for a code", "expired"
  // and "used too many times". Distinguishing them tells someone probing
  // the endpoint how close they are to something.
  if (!record || !record.isLive()) {
    return res.status(400).json({
      message: "That code is no longer valid. Request a new one.",
      errors: { code: "This code has expired or has already been used." },
    });
  }

  const matches = await record.compareCode(code);

  if (!matches) {
    record.attempts += 1;
    await record.save();

    const attemptsLeft = Math.max(MAX_ATTEMPTS - record.attempts, 0);

    return res.status(400).json({
      message: "That code is not correct.",
      errors: {
        code:
          attemptsLeft > 0
            ? `That code is not correct. ${attemptsLeft} ${
                attemptsLeft === 1 ? "attempt" : "attempts"
              } remaining.`
            : "Too many incorrect attempts. Request a new code.",
      },
      attemptsRemaining: attemptsLeft,
    });
  }

  record.consumedAt = new Date();
  await record.save();

  user.emailVerified = true;
  await user.save();

  try {
    await notifyEmailVerified(user);
  } catch (error) {
    console.error("Post-verification notification failed:", error.message);
  }

  res.status(200).json({
    message: "Your account is verified.",
    verified: true,
    user: user.toPublicJSON(),
  });
};

/* ==========================================================================
   PASSWORD RESET
   ========================================================================== */

/**
 * POST /api/auth/forgot-password
 * Body: { email }
 *
 * ==========================================================================
 *  WHY THIS ALWAYS REPLIES THE SAME WAY
 * ==========================================================================
 *
 * This endpoint is public and takes an email address. If it answered
 * "no account with that email" for unknown addresses and "code sent" for
 * known ones, it would be a free membership oracle: feed it a list of
 * addresses and it tells you which people have accounts here. For a barber
 * booking site that is a privacy leak about real customers.
 *
 * So the reply is identical either way, and the work is done quietly
 * behind it. The person who genuinely owns the address gets an email; the
 * person fishing gets a sentence that tells them nothing.
 *
 * Note this is the same reasoning the login route already uses for
 * "Invalid email or password" -- see authController.login. Register is the
 * one place that does reveal existence, and the comment there explains why
 * that tradeoff is made deliberately.
 */
const forgotPassword = async (req, res) => {
  const { email } = req.body;

  const sameAnswer = {
    message:
      "If an account exists for that email address, a reset code is on its way.",
  };

  const user = await User.findOne({ email: String(email).toLowerCase() });

  if (!user) return res.status(200).json(sameAnswer);

  // A suspended account must not be recoverable by its holder -- that would
  // be a way around the suspension. Same silent treatment: saying so here
  // would confirm the account exists.
  if (user.status === "suspended") return res.status(200).json(sameAnswer);

  const wait = await secondsUntilResendAllowed(user, "password_reset");
  if (wait > 0) return res.status(200).json(sameAnswer);

  try {
    await issueCode(user, "password_reset");
  } catch (error) {
    // A mail failure must not change the shape of the reply either.
    console.error("Password reset mail failed:", error.message);
  }

  res.status(200).json(sameAnswer);
};

/**
 * POST /api/auth/reset-password
 * Body: { email, code, password }
 */
const resetPassword = async (req, res) => {
  const { email, code, password } = req.body;

  const user = await User.findOne({ email: String(email).toLowerCase() });

  // Past this point the caller has already shown they know an address AND
  // claims a code for it, so a precise failure message is not a membership
  // oracle -- and a vague one here would leave a real user stuck.
  const invalid = () =>
    res.status(400).json({
      message: "That code is not valid.",
      errors: { code: "This code is wrong, expired, or already used." },
    });

  if (!user) return invalid();

  const record = await VerificationCode.findOne({
    user: user._id,
    purpose: "password_reset",
  })
    .sort({ createdAt: -1 })
    .select("+codeHash");

  if (!record || !record.isLive()) return invalid();

  const matches = await record.compareCode(code);
  if (!matches) {
    record.attempts += 1;
    await record.save();
    return invalid();
  }

  record.consumedAt = new Date();
  await record.save();

  // Assigning the plain password is correct: the pre("save") hook in
  // models/User.js hashes it. Doing it by hand here would risk storing a
  // plain password if that hook ever changed.
  user.password = password;
  await user.save();

  /**
   * Every other live code for this user is burned too.
   *
   * If somebody reset this password because the account was being abused,
   * leaving a valid verification code alive for the attacker would undo
   * the point of the reset.
   */
  await VerificationCode.updateMany(
    { user: user._id, consumedAt: null },
    { $set: { consumedAt: new Date() } }
  );

  /**
   * NOT logged in automatically.
   *
   * Signing them in here would mean one email code is enough to take over
   * a session. Making them log in with the new password proves they hold
   * the thing they just set.
   */
  try {
    await notifyPasswordChanged(user);
  } catch (error) {
    console.error("Password-changed notification failed:", error.message);
  }

  res.status(200).json({
    message: "Your password has been changed. You can now sign in.",
  });
};

/* ==========================================================================
   SESSION HELPERS
   ========================================================================== */

/**
 * Issues the login cookie. Shared with authController.
 *
 * "Remember me" has to lengthen BOTH the cookie and the token inside it.
 * Stretching only the cookie would look right and fail in practice: the
 * browser would keep sending a cookie whose JWT had already expired, so
 * the person would be silently logged out at the old expiry and the
 * setting would appear broken for no visible reason.
 *
 * What it does NOT change: the cookie stays httpOnly and same-site, and
 * nothing about the account is written to browser storage. The only thing
 * the browser keeps for "remember me" is the email address, saved by the
 * login page purely to prefill the field -- never the password, and never
 * a token. See client/src/pages/auth/LoginPage.js.
 */
const REMEMBER_ME_DAYS = 30;

const sendSession = (res, user, statusCode, message, remember = false) => {
  const token = remember
    ? signToken(user._id, `${REMEMBER_ME_DAYS}d`)
    : signToken(user._id);

  const options = cookieOptions();
  if (remember) {
    options.maxAge = REMEMBER_ME_DAYS * 24 * 60 * 60 * 1000;
  }

  res.cookie(COOKIE_NAME, token, options);
  res.status(statusCode).json({ message, user: user.toPublicJSON() });
};

module.exports = {
  sendVerification,
  verifyAccount,
  forgotPassword,
  resetPassword,
  // Exported for authController, pendingRegistrationController, and tests.
  issueCode,
  generateCode,
  maskEmail,
  sendSession,
  REMEMBER_ME_DAYS,
};
