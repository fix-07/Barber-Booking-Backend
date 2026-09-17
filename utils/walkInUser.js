const crypto = require("crypto");
const User = require("../models/User");

/**
 * Finds or creates the customer account behind an admin-created booking
 * (a walk-in, or a booking taken over the phone).
 *
 * WHY THIS EXISTS:
 * Booking.customer is a required reference to a User -- every booking in
 * this app belongs to a real account, and that stays true here rather than
 * inventing a separate "guest booking" shape the rest of the codebase would
 * need to special-case everywhere.
 *
 * If `existingUserId` is given, staff are booking someone who already has an
 * account (found via GET /api/admin/clients search). Otherwise this creates
 * a new customer record from name/email/phone -- with a long random password
 * nobody knows, hashed by User's own pre-save hook like any other password.
 * That account cannot be logged into (there is no password-reset flow in
 * this codebase yet), which is fine: a walk-in client did not ask for an
 * online account, only to have their appointment recorded. If they later
 * want to log in and manage bookings themselves, that needs a real
 * password-reset feature -- not something to fake here.
 */
const findOrCreateWalkInCustomer = async ({ existingUserId, name, email, phone }) => {
  if (existingUserId) {
    const user = await User.findOne({ _id: existingUserId, role: "customer" });
    if (!user) {
      const error = new Error("That client could not be found.");
      error.statusCode = 404;
      throw error;
    }
    return user;
  }

  if (!name || !email || !phone) {
    const error = new Error("A new client needs a name, email and phone number.");
    error.statusCode = 400;
    throw error;
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const existing = await User.findOne({ email: normalizedEmail });
  if (existing) {
    const error = new Error(
      `"${normalizedEmail}" is already registered. Search for the existing client instead of creating a new one.`
    );
    error.statusCode = 409;
    throw error;
  }

  const user = await User.create({
    name,
    email: normalizedEmail,
    phone,
    password: crypto.randomBytes(24).toString("hex"),
    role: "customer",
    // They never ticked a consent box themselves -- staff did this on their
    // behalf, so recording "agreed" would be false.
    acceptedPolicies: false,
    acceptedPoliciesAt: null,
  });

  return user;
};

module.exports = { findOrCreateWalkInCustomer };
