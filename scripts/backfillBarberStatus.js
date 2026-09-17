/**
 * One-off migration for the account-status feature (barber approval +
 * client/barber suspension).
 *
 * WHY THIS EXISTS:
 * User.status is a field with schema default "active". Mongoose applies
 * that default when it HYDRATES a document (e.g. every find()), but a raw
 * query filter like User.find({ status: "active" }) runs at the MongoDB
 * level and does NOT see schema defaults -- it only matches documents that
 * actually have status: "active" stored. Without this backfill, every
 * account that existed before this field shipped would silently fail any
 * such filter (the public barber list, admin views that filter by status,
 * login's suspended-customer check, etc.), even though the intent is clear:
 * every pre-existing account (barber, customer, or admin) should count as
 * ACTIVE until an admin explicitly changes that.
 *
 * Originally this only covered barbers (hence the filename); it now covers
 * every role, since customers can be suspended too (see
 * adminClientController.suspendClient).
 *
 * Safe to run more than once -- status: { $exists: false } means an
 * already-migrated (or newly created, which always gets status from the
 * schema default at creation time) user is untouched.
 *
 * USAGE:
 *   node server/scripts/backfillBarberStatus.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const connectDB = require("../config/db");
const User = require("../models/User");

const run = async () => {
  await connectDB();

  try {
    const result = await User.updateMany(
      { status: { $exists: false } },
      { $set: { status: "active" } }
    );

    console.log(
      `Backfilled status: "active" on ${result.modifiedCount} existing account(s) (all roles).`
    );
  } finally {
    await mongoose.connection.close();
  }
};

run().catch((error) => {
  console.error("\nBackfill failed:", error.message);
  process.exit(1);
});
