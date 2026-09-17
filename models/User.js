const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

/**
 * User account.
 *
 * DATA MINIMIZATION: we only store what booking genuinely needs.
 * There is deliberately no date of birth, no gender, no address,
 * and no tracking data, because none of those are required to
 * create an account or book a haircut.
 *
 * Phone is optional and exists only so a barber can contact a
 * customer about their appointment.
 */
const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
      minlength: [2, "Name must be at least 2 characters"],
      maxlength: [60, "Name cannot be longer than 60 characters"],
    },

    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      trim: true,
      lowercase: true, // stops "Bob@x.com" and "bob@x.com" becoming two accounts
      maxlength: [254, "Email is too long"],
    },

    /**
     * How this account proves who it is. "local" means a password set at
     * signup; "google" means Google Sign-In -- see utils/googleAuth.js and
     * controllers/googleAuthController.js. This is what makes `password`
     * and `phone` below CONDITIONALLY required rather than always: a
     * Google account never sets a password (Google is the credential), and
     * never arrives with a phone number (Google doesn't hand one over).
     */
    authProvider: {
      type: String,
      enum: {
        values: ["local", "google"],
        message: "authProvider must be local or google",
      },
      default: "local",
    },

    // Google's own stable per-account id ("sub" in the ID token). Only set
    // for authProvider "google". Sparse so many local accounts can all
    // have this field simply absent, rather than colliding on `null`.
    googleId: {
      type: String,
      default: undefined,
      index: { unique: true, sparse: true },
    },

    password: {
      type: String,
      // Required for a local account; a Google account has no password at
      // all -- Google's own sign-in IS the credential, so asking it to
      // also hold a password here would mean storing a secret that can
      // never actually be used to log in (this endpoint never accepts one
      // for a Google account) and would just be one more thing that could
      // leak.
      required: function requiredForLocal() {
        return this.authProvider === "local";
      },
      minlength: [8, "Password must be at least 8 characters"],
      // select: false means the password hash is NEVER included when you
      // query users, unless you explicitly ask for it. This is the single
      // most effective guard against accidentally leaking hashes in an API
      // response.
      select: false,
    },

    // REQUIRED for a local account. A barber needs a way to reach a
    // customer about their appointment (a change of time, a delay, a
    // cancellation), and email alone is often too slow for that on the
    // day. Keep this in step with the validator in routes/authRoutes.js
    // and the wording in pages/legal/PrivacyPolicyPage.js -- all three
    // must agree on whether this field is required.
    //
    // NOT required at the schema level for a Google account: Google never
    // hands over a phone number, so a brand-new Google sign-in has none
    // yet. That does not make it optional in practice -- a phone-less
    // account is real and logged in, but bookingController.createBooking
    // refuses to let it book until one is added (the actual enforcement;
    // the client-side redirect to /complete-profile is only a courtesy on
    // top of that -- see auth/roleRoutes.js).
    phone: {
      type: String,
      required: function requiredForLocal() {
        return this.authProvider === "local";
      },
      trim: true,
      maxlength: [30, "Phone number is too long"],
      default: "",
    },

    role: {
      type: String,
      enum: {
        values: ["customer", "barber", "admin"],
        message: "Role must be customer, barber or admin",
      },
      default: "customer",
    },

    /**
     * Has this person proved they control the address on the account?
     *
     * NAMED FOR WHAT IT ACTUALLY PROVES. The signup flow emails a 6-digit
     * code, so completing it proves control of the EMAIL address, and
     * nothing at all about the phone number. Calling this "phoneVerified"
     * would put a false claim in the database -- and it is exactly the kind
     * of field someone later trusts ("we can text this customer, it's
     * verified") without re-reading how it was set.
     *
     * If SMS is added later, that is a second field alongside this one, set
     * by its own flow. See utils/mailer.js for how delivery is configured.
     */
    emailVerified: {
      type: Boolean,
      default: false,
    },

    /**
     * Account approval state. Only meaningful for role "barber" -- customers
     * and admins are always "active" and never move out of it.
     *
     * A barber who self-registers starts at "pending_approval" (see
     * authController.register) and cannot use the barber dashboard or
     * receive bookings until an admin approves them (see
     * middleware/auth.js's requireActiveBarber, applied to every protected
     * barber route). A barber created directly BY an admin
     * (adminBarberController.createBarber) starts "active" immediately --
     * the admin creating the account IS the review.
     */
    status: {
      type: String,
      enum: {
        values: ["pending_approval", "active", "rejected", "suspended"],
        message: "Status must be pending_approval, active, rejected or suspended",
      },
      default: "active",
    },

    // Set by an admin when rejecting a barber application (see
    // adminBarberApprovalController.rejectApplication). Shown back to the
    // barber on their status page. Irrelevant for any other status.
    rejectionReason: {
      type: String,
      trim: true,
      maxlength: [500, "Rejection reason cannot be longer than 500 characters"],
      default: "",
    },

    // Records that the person actively ticked the consent box at signup.
    // Storing WHEN they agreed is the point: it is the evidence.
    acceptedPolicies: {
      type: Boolean,
      required: true,
      default: false,
    },
    acceptedPoliciesAt: {
      type: Date,
      default: null,
    },

    // Internal note staff can keep about a client (allergies, preferences,
    // a past dispute) -- never shown to the customer themselves, and never
    // included in toPublicJSON. Only toAdminJSON below returns it.
    adminNotes: {
      type: String,
      trim: true,
      maxlength: [2000, "Notes cannot be longer than 2000 characters"],
      default: "",
    },

    // Consecutive wrong-password attempts since the last SUCCESSFUL login.
    // Reset to 0 the moment a login succeeds. Used only to trigger the
    // "repeated failed sign-in attempts" alert email (see
    // services/notificationService.js's notifySuspiciousLogin) -- this is
    // NOT account lockout; a genuine owner who mistypes their password
    // several times can still log in the moment they get it right. Never
    // returned by toPublicJSON: it is an internal security signal, not
    // something to show the account holder or leak to an attacker probing
    // whether an email exists.
    failedLoginAttempts: { type: Number, default: 0 },
    lastFailedLoginAt: { type: Date, default: null },
  },
  {
    // Adds createdAt and updatedAt automatically.
    timestamps: true,
  }
);

/**
 * Hash the password automatically before saving.
 *
 * Putting this in the model (instead of in the route) means a password
 * can never be stored in plain text by mistake, no matter which part of
 * the app creates the user.
 *
 * isModified("password") stops us from re-hashing an already hashed
 * password when the user updates, say, only their name.
 *
 * ESCAPE HATCH: set `user.$locals.skipPasswordHashing = true` before
 * saving to store `password` exactly as given, with no hashing here.
 * The one legitimate use is controllers/pendingRegistrationController.js
 * finishing a signup: the password was already hashed once, at the moment
 * the PendingRegistration was created (see that model's header comment for
 * why it is never held in plain text). Hashing it again here would hash
 * the HASH, and bcrypt.compare against the real password would then always
 * fail -- nobody who just chose that password could ever log in with it.
 * `$locals` is Mongoose's own per-document scratch object: it is never
 * persisted and never comes from client input, so nothing a request sends
 * can trigger this path by itself.
 *
 * MONGOOSE 9 NOTE: an async hook must NOT take a "next" argument.
 * Older tutorials written for Mongoose 7/8 show
 *     async function (next) { ... next(); }
 * In Mongoose 9 that crashes with "next is not a function", because
 * Mongoose now waits on the returned promise instead of a callback.
 * So we simply return.
 */
userSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  if (this.$locals.skipPasswordHashing) return;

  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
});

/**
 * Compares a plain-text login attempt against the stored hash.
 * Used by the login route.
 */
userSchema.methods.comparePassword = function (plainTextPassword) {
  return bcrypt.compare(plainTextPassword, this.password);
};

/**
 * Returns a safe copy of the user for sending to the frontend.
 * Explicitly lists what goes out, so a new sensitive field added later
 * is not exposed by accident.
 */
userSchema.methods.toPublicJSON = function () {
  return {
    id: this._id,
    name: this.name,
    email: this.email,
    phone: this.phone,
    role: this.role,
    // The frontend needs this to know whether "no phone on file" means
    // "hasn't got round to it yet" (google) vs something having gone
    // wrong (local accounts always have one -- see the phone field's
    // conditional `required` above). Also lets the UI skip showing a
    // "change password" option for an account that has none.
    authProvider: this.authProvider,
    // Meaningful for barbers only, but harmless to send for anyone --
    // customers/admins are always "active". This is what
    // components/ProtectedRoute.js's barberActiveGate reads client-side; the
    // real enforcement is requireActiveBarber on the server.
    status: this.status,
    rejectionReason: this.role === "barber" ? this.rejectionReason : undefined,
    // The frontend needs this to know whether to route someone to the
    // verification screen after login. It says whether verification
    // happened, never anything about the code used to do it.
    emailVerified: this.emailVerified,
    createdAt: this.createdAt,
  };
};

/**
 * Shape sent to ADMIN endpoints only -- adds adminNotes on top of the public
 * shape. Never used on any route a non-admin can reach.
 */
userSchema.methods.toAdminJSON = function () {
  return {
    ...this.toPublicJSON(),
    adminNotes: this.adminNotes,
  };
};

const User = mongoose.model("User", userSchema);

module.exports = User;
