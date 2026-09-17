const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

/**
 * A signup that has not been proven yet.
 *
 * ==========================================================================
 *  WHY THIS MODEL EXISTS
 * ==========================================================================
 *
 * Previously, POST /api/auth/register created the real User (and
 * BarberProfile, for a barber) immediately, then emailed a code and let the
 * person use the app in an "unverified" state until they entered it. That
 * means every abandoned signup -- a typo'd email, someone who closed the
 * tab, a bot -- left a permanent User document behind and permanently
 * squatted that email address, since a real account with that email now
 * genuinely exists (register's own duplicate-email check would refuse a
 * second attempt at it forever).
 *
 * This model exists so a User is not created until the code is actually
 * verified. Registering now creates ONE of these instead: everything the
 * final account will need, none of it a real account yet.
 *
 * ==========================================================================
 *  IT SELF-DELETES
 * ==========================================================================
 *
 * The TTL index below removes a document once `expiresAt` passes, with no
 * job or cron needed. An abandoned signup simply stops existing after the
 * code's lifetime, and the email becomes free to register again -- which is
 * the literal behaviour asked for: fail to verify, and there is no account.
 *
 * ==========================================================================
 *  THE PASSWORD IS HASHED HERE, NOT LEFT PLAIN
 * ==========================================================================
 *
 * The tempting shortcut is to hold the plain password until verification
 * succeeds and only hash it then. That would mean a real password sits in
 * the database in plain text for up to CODE_TTL_MINUTES, which is a
 * regression from how this app has treated passwords everywhere else.
 * Instead controllers/verificationController.js hashes it with bcrypt the
 * moment this document is created, and that hash is copied verbatim onto
 * the real User at verification time -- see the skipPasswordHashing escape
 * hatch on models/User.js for how that copy avoids being hashed a second
 * time.
 */

const pendingRegistrationSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true, // one pending attempt per address; a new one replaces it
      trim: true,
      lowercase: true,
    },

    name: { type: String, required: true, trim: true },

    // Already a bcrypt hash by the time it reaches this schema. See the
    // header comment for why it is never the plain password.
    passwordHash: {
      type: String,
      required: true,
      select: false,
    },

    phone: { type: String, required: true, trim: true },

    role: {
      type: String,
      enum: ["customer", "barber"],
      required: true,
    },

    acceptedPolicies: { type: Boolean, required: true },
    acceptedPoliciesAt: { type: Date, required: true },

    // Barber application fields, matching BarberProfile's own shape.
    // Empty/unused for a customer signup.
    shopName: { type: String, trim: true, default: "" },
    city: { type: String, trim: true, default: "" },
    region: { type: String, trim: true, default: "" },
    country: { type: String, trim: true, default: "" },
    addressLine: { type: String, trim: true, default: "" },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    locationConfirmed: { type: Boolean, default: false },
    timeZone: { type: String, trim: true, default: "" },
    bio: { type: String, trim: true, default: "" },
    experience: { type: String, trim: true, default: "" },
    specialties: { type: [String], default: [] },
    requestedServices: { type: [String], default: [] },
    photoUrl: { type: String, trim: true, default: "" },

    // bcrypt hash of the 6-digit code. Never the digits themselves -- same
    // reasoning as models/VerificationCode.js.
    codeHash: {
      type: String,
      required: true,
      select: false,
    },

    // When the CURRENT code was issued. Regenerating a code (resend)
    // updates this in place rather than creating a new document, so the
    // rest of the submitted form is never lost to a resend.
    codeIssuedAt: { type: Date, required: true },

    expiresAt: { type: Date, required: true },

    attempts: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

// MongoDB removes a document once expiresAt passes -- the whole mechanism
// that makes "never verified" mean "never existed for long".
pendingRegistrationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const MAX_ATTEMPTS = 5;

pendingRegistrationSchema.methods.isLive = function () {
  return this.expiresAt > new Date() && this.attempts < MAX_ATTEMPTS;
};

pendingRegistrationSchema.methods.compareCode = function (plainCode) {
  return bcrypt.compare(String(plainCode), this.codeHash);
};

const PendingRegistration = mongoose.model(
  "PendingRegistration",
  pendingRegistrationSchema
);

module.exports = PendingRegistration;
module.exports.MAX_ATTEMPTS = MAX_ATTEMPTS;
