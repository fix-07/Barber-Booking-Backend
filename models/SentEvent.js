const mongoose = require("mongoose");

/**
 * The idempotency ledger for notifications.
 *
 * ==========================================================================
 *  WHY THIS EXISTS
 * ==========================================================================
 *
 * "Do not send duplicate emails for the same event" is a real requirement,
 * not a nice-to-have: a booking confirmation firing twice (a double
 * network retry, a webhook redelivered, an admin double-clicking Approve
 * before the button disabled) would look like a bug to the person reading
 * their inbox even though nothing was actually wrong.
 *
 * `key` is a single string built from the event and the specific record it
 * is about -- e.g. "booking:confirmed:64f...", "barber:approved:64a...".
 * The unique index is the actual enforcement: two processes racing to
 * send the same event both try to insert the same key, and only one
 * insert can ever succeed. See services/notificationService.js's
 * `sendOnce`, which is the only thing that ever writes here.
 */
const sentEventSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SentEvent", sentEventSchema);
