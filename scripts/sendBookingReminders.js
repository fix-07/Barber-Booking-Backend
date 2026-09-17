/**
 * Sends a reminder email for every CONFIRMED booking starting in the next
 * REMINDER_WINDOW_HOURS hours.
 *
 * ==========================================================================
 *  WHY THIS IS A SEPARATE SCRIPT, NOT SOMETHING THE SERVER DOES ON ITS OWN
 * ==========================================================================
 *
 * This Express app has no background job runner -- it only does work in
 * response to an incoming HTTP request. "Send a reminder N hours before
 * an appointment" needs something to notice the passage of time with
 * nobody making a request, which means it has to live outside the normal
 * request/response cycle.
 *
 * Run this on a schedule from OUTSIDE the app -- cron, Windows Task
 * Scheduler, or your hosting platform's own scheduled-job feature -- e.g.
 * every hour:
 *
 *     0 * * * *  cd /path/to/server && node scripts/sendBookingReminders.js
 *
 * It is safe to run more than once for the same booking on the same day:
 * notifyBookingReminder's dedupe key is bucketed by booking + calendar
 * day, so a second run within the same day sends nothing twice.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Booking = require("../models/Booking");
const User = require("../models/User");
const BarberProfile = require("../models/BarberProfile");
const { notifyBookingReminder } = require("../services/notificationService");

const REMINDER_WINDOW_HOURS = Number(process.env.REMINDER_WINDOW_HOURS) || 24;

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const now = new Date();
  const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_HOURS * 60 * 60 * 1000);

  const upcoming = await Booking.find({
    status: "confirmed",
    startAt: { $gt: now, $lte: windowEnd },
  });

  console.log(`Found ${upcoming.length} confirmed booking(s) in the next ${REMINDER_WINDOW_HOURS}h.`);

  let sent = 0;
  for (const booking of upcoming) {
    // eslint-disable-next-line no-await-in-loop
    const [customer, barber, profile] = await Promise.all([
      User.findById(booking.customer).select("name email"),
      User.findById(booking.barber).select("name email"),
      BarberProfile.findOne({ user: booking.barber }).select("timeZone"),
    ]);

    if (!customer || !barber) continue; // an account was deleted; nothing to send

    try {
      // eslint-disable-next-line no-await-in-loop
      await notifyBookingReminder(booking, customer, barber, profile ? profile.timeZone : undefined);
      sent += 1;
    } catch (error) {
      console.error(`Reminder failed for booking ${booking._id}:`, error.message);
    }
  }

  console.log(`Done. ${sent} reminder(s) processed (duplicates for today were skipped automatically).`);
  await mongoose.disconnect();
};

run().catch((error) => {
  console.error("sendBookingReminders crashed:", error);
  process.exit(1);
});
