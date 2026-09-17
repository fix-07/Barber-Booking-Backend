const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

/**
 * A one-time 6-digit code, for verifying an account or resetting a password.
 *
 * ==========================================================================
 *  THE CODE ITSELF IS NEVER STORED
 * ==========================================================================
 *
 * Only a bcrypt hash of it is. This is the same reasoning as passwords: if
 * this collection ever leaked, the codes in it would be useless. It costs
 * one bcrypt comparison per verification attempt, which is nothing at this
 * volume.
 *
 * Nothing in the app ever reads a code back out. The plain code exists for
 * exactly as long as it takes to hash it and hand it to the mailer -- see
 * issueCode() in controllers/authController.js.
 *
 * ==========================================================================
 *  WHAT STOPS THIS BEING BRUTE-FORCED
 * ==========================================================================
 *
 * A 6-digit code is only a million possibilities, which is not many. Three
 * separate limits make guessing it impractical, and all three are enforced
 * HERE on the server, not in the browser:
 *
 *   1. EXPIRY       a code is dead after CODE_TTL_MINUTES, whether or not
 *                   anyone used it. The TTL index below also deletes the
 *                   row itself, so old codes do not pile up forever.
 *   2. ATTEMPTS     MAX_ATTEMPTS wrong guesses burns the code permanently.
 *                   The attacker has to request a new one, which is
 *                   rate limited.
 *   3. RATE LIMIT   see verificationLimiter in middleware/rateLimit.js.
 *
 * ==========================================================================
 *  ONE LIVE CODE PER PURPOSE
 * ==========================================================================
 *
 * Issuing a new code consumes any previous one for the same user and
 * purpose. Without that, every "resend" would leave another valid code
 * alive, and a long session of resends would widen the guessing window
 * instead of narrowing it.
 */

const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;

// How long a caller must wait between requesting codes. Enforced on the
// server; the countdown in the UI is only a reflection of this number.
const RESEND_COOLDOWN_SECONDS = 60;

const verificationCodeSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    purpose: {
      type: String,
      enum: {
        values: ["account_verification", "password_reset"],
        message: "Purpose must be account_verification or password_reset",
      },
      required: true,
    },

    // bcrypt hash of the 6 digits. Never the digits themselves.
    codeHash: {
      type: String,
      required: true,
      // Belt and braces on top of never selecting it: a stray
      // .find() cannot return this field unless it is asked for by name.
      select: false,
    },

    expiresAt: {
      type: Date,
      required: true,
    },

    attempts: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Set when the code is successfully used, or when it is superseded by a
    // newer one. A consumed code can never verify anything again.
    consumedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

/**
 * MongoDB deletes a document automatically once expiresAt passes.
 *
 * This is housekeeping, NOT the security control -- the background task
 * that honours it only runs about once a minute, so a document can outlive
 * its expiry by a little. Every read path checks expiresAt itself rather
 * than trusting the row's continued existence to mean anything.
 */
verificationCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// The lookup every verify does: newest live code for this user and purpose.
verificationCodeSchema.index({ user: 1, purpose: 1, createdAt: -1 });

/** Still usable: not consumed, not expired, attempts left. */
verificationCodeSchema.methods.isLive = function () {
  return (
    !this.consumedAt &&
    this.expiresAt > new Date() &&
    this.attempts < MAX_ATTEMPTS
  );
};

verificationCodeSchema.methods.compareCode = function (plainCode) {
  return bcrypt.compare(String(plainCode), this.codeHash);
};

const VerificationCode = mongoose.model(
  "VerificationCode",
  verificationCodeSchema
);

module.exports = VerificationCode;
module.exports.CODE_TTL_MINUTES = CODE_TTL_MINUTES;
module.exports.MAX_ATTEMPTS = MAX_ATTEMPTS;
module.exports.RESEND_COOLDOWN_SECONDS = RESEND_COOLDOWN_SECONDS;
