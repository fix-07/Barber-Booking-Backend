const Notification = require("../models/Notification");
const SentEvent = require("../models/SentEvent");
const User = require("../models/User");
const { sendMail } = require("../utils/mailer");

/**
 * Plain-text money and date formatting for email bodies. There is no
 * server-side format util in this codebase to import (client/src/utils/
 * format.js is a browser-only module) -- these two are intentionally
 * small rather than pulling the client's formatter across the boundary.
 */
const formatMoney = (priceMinor, currency) => {
  if (priceMinor === null || priceMinor === undefined) return "";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "USD",
    }).format(priceMinor / 100);
  } catch {
    return `${(priceMinor / 100).toFixed(2)} ${currency || ""}`.trim();
  }
};

const formatDateTimeInZone = (date, timeZone) => {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "full",
      timeStyle: "short",
      timeZone,
    }).format(new Date(date));
  } catch {
    return new Date(date).toUTCString();
  }
};

/**
 * The single place every "something happened, tell someone" event in this
 * app goes through: an in-app notification row, and an email, together.
 *
 * ==========================================================================
 *  THE RULE THIS FILE EXISTS TO ENFORCE
 * ==========================================================================
 *
 * "If an email cannot be sent, the main action must not silently fail."
 * Every function here is called AFTER the real action (the booking, the
 * approval, the account) has already been saved. A failure in here is
 * caught, logged loudly, and recorded on the notification document itself
 * (`emailStatus`/`emailError`) -- it never throws back into the caller.
 * See the try/catch in `notify` below; there is exactly one.
 *
 * ==========================================================================
 *  IDEMPOTENCY
 * ==========================================================================
 *
 * `dedupeKey`, when given, is inserted into SentEvent BEFORE anything else
 * happens. The unique index on that collection is the actual guarantee: if
 * two requests (a retry, a double-click, a redelivered webhook) reach here
 * for the same event, only the first insert succeeds and the second
 * returns immediately having sent nothing twice. Callers build the key
 * from the event name and the specific record's id, e.g.
 * "booking:confirmed:<bookingId>".
 */
const sendOnce = async (dedupeKey) => {
  if (!dedupeKey) return true; // no key given -- caller accepts this may repeat
  try {
    await SentEvent.create({ key: dedupeKey });
    return true; // we are the first; proceed
  } catch (error) {
    if (error.code === 11000) return false; // already handled once
    throw error;
  }
};

/**
 * Creates the in-app notification and sends the email for one event.
 *
 * `user` may be a populated User document or just an id -- either works,
 * since only `_id`/`email`/`name` are read off it.
 */
const notify = async ({
  user,
  type,
  title,
  message,
  link,
  subject,
  text,
  dedupeKey,
}) => {
  const isNew = await sendOnce(dedupeKey);
  if (!isNew) return; // duplicate event, nothing to do

  const userId = user._id || user;
  const notification = await Notification.create({
    user: userId,
    type,
    title,
    message,
    link: link || "",
  });

  // Need the email address if `user` was passed as a bare id.
  const recipient = user.email ? user : await User.findById(userId).select("email name");
  if (!recipient || !recipient.email) {
    notification.emailStatus = "skipped";
    notification.emailError = "No email address on file for this user.";
    await notification.save();
    return;
  }

  try {
    await sendMail({ to: recipient.email, subject, text });
    notification.emailStatus = "sent";
  } catch (error) {
    // LOGGED LOUDLY, NEVER THROWN. The booking/approval/account this
    // event describes already happened and stays happened -- see the
    // header comment. console.error here is the "clear status for
    // administrators" for now; emailStatus/emailError on the notification
    // document is the same information kept somewhere queryable, not just
    // scrolled past in a log.
    console.error(`NOTIFICATION EMAIL FAILED (${type}) to ${recipient.email}:`, error.message);
    notification.emailStatus = "failed";
    notification.emailError = String(error.message || error).slice(0, 500);
  }

  await notification.save();
};

/** Sends the same event to every admin account. Used for the one
 *  "notify staff" case this app has: a new barber application. */
const notifyAllAdmins = async (build) => {
  const admins = await User.find({ role: "admin" }).select("email name");
  await Promise.all(admins.map((admin) => notify(build(admin))));
};

const fmtWhen = (date, timeZone) =>
  timeZone ? formatDateTimeInZone(date, timeZone) : new Date(date).toUTCString();

/* ==========================================================================
   AUTH
   ========================================================================== */

const notifyEmailVerified = (user) =>
  notify({
    user,
    type: "account_verified",
    title: "Your account is verified",
    message: "Your email address has been verified. Welcome to VEYRON.",
    subject: "Your VEYRON account is verified",
    text: `Hello ${user.name},\n\nYour email address is verified and your account is ready to use.\n\nVEYRON`,
    dedupeKey: `account:verified:${user._id}`,
  });

const notifyPasswordChanged = (user) =>
  notify({
    user,
    type: "password_reset",
    title: "Your password was changed",
    message: "Your VEYRON password was just changed. If this wasn't you, contact us immediately.",
    subject: "Your VEYRON password was changed",
    text: [
      `Hello ${user.name},`,
      "",
      "This confirms your VEYRON account password was just changed.",
      "",
      "If you did not make this change, contact us immediately -- someone else may have access to your account.",
      "",
      "VEYRON",
    ].join("\n"),
    // No dedupeKey: a genuine second password change is a genuine second
    // event and should send again.
  });

/**
 * Repeated failed logins for one account within a short window. Fired from
 * authController.login. The dedupe key includes an hour-bucket, so a
 * sustained attack still gets at most one alert per hour rather than one
 * per attempt.
 */
const notifySuspiciousLogin = (user, attemptCount) =>
  notify({
    user,
    type: "admin_announcement",
    title: "Repeated failed sign-in attempts",
    message: `There have been ${attemptCount} failed sign-in attempts on your account recently.`,
    subject: "Unusual sign-in activity on your VEYRON account",
    text: [
      `Hello ${user.name},`,
      "",
      `There have been ${attemptCount} failed attempts to sign in to your VEYRON account recently.`,
      "If this was you, you can ignore this message. If it wasn't, consider resetting your password.",
      "",
      "VEYRON",
    ].join("\n"),
    dedupeKey: `login:suspicious:${user._id}:${new Date().toISOString().slice(0, 13)}`,
  });

/* ==========================================================================
   BARBER APPROVAL
   ========================================================================== */

const notifyBarberApplicationReceived = (user) =>
  notify({
    user,
    type: "barber_application_received",
    title: "Application received",
    message: "Your barber application has been submitted and is awaiting review.",
    subject: "Your VEYRON barber application is being reviewed",
    text: [
      `Hello ${user.name},`,
      "",
      "Thanks for applying to join VEYRON as a barber. Your application is now waiting for review by our team.",
      "You can sign in any time to check its status.",
      "",
      "VEYRON",
    ].join("\n"),
    dedupeKey: `barber:application_received:${user._id}`,
  });

/** To every admin, with a direct link to the review queue. */
const notifyAdminNewBarberApplication = (barberUser, profile) =>
  notifyAllAdmins((admin) => ({
    user: admin,
    type: "barber_application_received",
    title: "New barber application",
    message: `${barberUser.name} (${profile ? profile.shopName : "no shop name"}) applied to join as a barber.`,
    link: "/admin/barber-approvals",
    subject: "New VEYRON barber application awaiting review",
    text: [
      `A new barber application needs review.`,
      "",
      `Name: ${barberUser.name}`,
      `Email: ${barberUser.email}`,
      `Shop: ${profile ? profile.shopName : "(not given)"}`,
      `City: ${profile ? profile.city : "(not given)"}`,
      "",
      `Review it here: ${adminReviewUrl()}`,
      "",
      "VEYRON",
    ].join("\n"),
    dedupeKey: `admin:new_barber_application:${barberUser._id}:${admin._id}`,
  }));

const adminReviewUrl = () =>
  `${process.env.CLIENT_ORIGIN || "http://localhost:3000"}/admin/barber-approvals`;

const notifyBarberApproved = (user) =>
  notify({
    user,
    type: "barber_approved",
    title: "Application approved",
    message: "Your barber application has been approved. Your profile is now live.",
    subject: "Your VEYRON barber application was approved",
    text: [
      `Hello ${user.name},`,
      "",
      "Good news -- your barber application has been approved. Your profile is now visible to customers and you can start receiving bookings.",
      "",
      "VEYRON",
    ].join("\n"),
    dedupeKey: `barber:approved:${user._id}:${Date.now()}`,
  });

const notifyBarberRejected = (user, reason) =>
  notify({
    user,
    type: "barber_rejected",
    title: "Application not approved",
    message: reason
      ? `Your barber application was not approved. Reason: ${reason}`
      : "Your barber application was not approved.",
    subject: "Your VEYRON barber application",
    text: [
      `Hello ${user.name},`,
      "",
      "We've reviewed your barber application and are not able to approve it at this time.",
      reason ? `\nReason given: ${reason}\n` : "",
      "You can update your application and resubmit it from your account.",
      "",
      "VEYRON",
    ].join("\n"),
    dedupeKey: `barber:rejected:${user._id}:${Date.now()}`,
  });

const notifyBarberSuspended = (user) =>
  notify({
    user,
    type: "barber_suspended",
    title: "Account suspended",
    message: "Your barber account has been suspended. Your profile is no longer visible to customers.",
    subject: "Your VEYRON barber account has been suspended",
    text: [
      `Hello ${user.name},`,
      "",
      "Your VEYRON barber account has been suspended and your profile is no longer visible to customers.",
      "Contact VEYRON if you believe this is a mistake.",
      "",
      "VEYRON",
    ].join("\n"),
    dedupeKey: `barber:suspended:${user._id}:${Date.now()}`,
  });

const notifyBarberReactivated = (user) =>
  notify({
    user,
    type: "barber_reactivated",
    title: "Account reactivated",
    message: "Your barber account has been reactivated. Your profile is visible to customers again.",
    subject: "Your VEYRON barber account has been reactivated",
    text: [
      `Hello ${user.name},`,
      "",
      "Your VEYRON barber account has been reactivated. Your profile is visible to customers again and you can take bookings.",
      "",
      "VEYRON",
    ].join("\n"),
    dedupeKey: `barber:reactivated:${user._id}:${Date.now()}`,
  });

/* ==========================================================================
   BOOKINGS
   ========================================================================== */

/**
 * The common block of facts every booking email includes.
 *
 * DELIBERATELY NOT booking.customerNameAtBooking / .barberNameAtBooking:
 * those two fields are `null` for the entire life of a normal, live
 * booking -- they are a snapshot ONLY ever written when the underlying
 * User account is later deleted (see adminClientController.deleteClient
 * and adminBarberController.deleteBarber). Using them here would print
 * "null" in every booking email for as long as both accounts still exist,
 * which is nearly always. `customer.name` / `barber.name` -- the real,
 * live account names, already fetched by every caller below to get an
 * email address -- are what's actually correct here.
 */
const bookingFacts = (booking, customerName, barberName, timeZone) => [
  `Customer: ${customerName}`,
  `Barber:   ${barberName}`,
  `Service:  ${booking.serviceNameAtBooking}`,
  `When:     ${fmtWhen(booking.startAt, timeZone)}`,
  `Price:    ${formatMoney(booking.priceMinorAtBooking, booking.currencyAtBooking)}`,
  `Status:   ${booking.status}`,
];

const notifyBookingCreated = (booking, customer, barber, timeZone) =>
  Promise.all([
    notify({
      user: customer,
      type: "booking_created",
      title: "Booking requested",
      message: `Your appointment with ${barber.name} has been requested and is awaiting confirmation.`,
      link: "/my-bookings",
      subject: "Your VEYRON booking request",
      text: [
        `Hello ${customer.name},`,
        "",
        "Your appointment request has been sent to the barber. You'll be notified as soon as it's confirmed.",
        "",
        ...bookingFacts(booking, customer.name, barber.name, timeZone),
        "",
        "VEYRON",
      ].join("\n"),
      dedupeKey: `booking:created:customer:${booking._id}`,
    }),
    notify({
      user: barber,
      type: "booking_created",
      title: "New booking request",
      message: `${customer.name} requested an appointment for ${booking.serviceNameAtBooking}.`,
      link: "/barber/appointments",
      subject: "New VEYRON booking request",
      text: [
        `Hello ${barber.name},`,
        "",
        "You have a new appointment request. Confirm or decline it from your dashboard.",
        "",
        ...bookingFacts(booking, customer.name, barber.name, timeZone),
        "",
        "VEYRON",
      ].join("\n"),
      dedupeKey: `booking:created:barber:${booking._id}`,
    }),
  ]);

const notifyBookingConfirmed = (booking, customer, barber, timeZone) =>
  notify({
    user: customer,
    type: "booking_confirmed",
    title: "Booking confirmed",
    message: `${barber.name} confirmed your appointment for ${booking.serviceNameAtBooking}.`,
    link: "/my-bookings",
    subject: "Your VEYRON booking is confirmed",
    text: [
      `Hello ${customer.name},`,
      "",
      "Your appointment has been confirmed.",
      "",
      ...bookingFacts(booking, customer.name, barber.name, timeZone),
      "",
      "VEYRON",
    ].join("\n"),
    dedupeKey: `booking:confirmed:${booking._id}`,
  });

/** Barber declined a still-PENDING request -- worded as a rejection. */
const notifyBookingRejected = (booking, customer, barber, timeZone) =>
  notify({
    user: customer,
    type: "booking_rejected",
    title: "Booking request declined",
    message: `${barber.name} was unable to accept your appointment request.`,
    link: "/my-bookings",
    subject: "Your VEYRON booking request was declined",
    text: [
      `Hello ${customer.name},`,
      "",
      "Unfortunately your appointment request could not be accepted.",
      "",
      ...bookingFacts(booking, customer.name, barber.name, timeZone),
      "",
      "You're welcome to request a different time.",
      "",
      "VEYRON",
    ].join("\n"),
    dedupeKey: `booking:rejected:${booking._id}`,
  });

const notifyBookingCancelledByCustomer = (booking, customer, barber, timeZone) =>
  notify({
    user: barber,
    type: "booking_cancelled",
    title: "Booking cancelled",
    message: `${customer.name} cancelled their appointment for ${booking.serviceNameAtBooking}.`,
    link: "/barber/appointments",
    subject: "A VEYRON booking was cancelled",
    text: [
      `Hello ${barber.name},`,
      "",
      "A customer has cancelled their appointment.",
      "",
      ...bookingFacts(booking, customer.name, barber.name, timeZone),
      "",
      "VEYRON",
    ].join("\n"),
    dedupeKey: `booking:cancelled_by_customer:${booking._id}`,
  });

/** Cancelled by the barber AFTER it was already confirmed. */
const notifyBookingCancelledByBarber = (booking, customer, barber, timeZone) =>
  notify({
    user: customer,
    type: "booking_cancelled",
    title: "Booking cancelled by barber",
    message: `${barber.name} had to cancel your confirmed appointment.`,
    link: "/my-bookings",
    subject: "Your VEYRON booking was cancelled",
    text: [
      `Hello ${customer.name},`,
      "",
      "Your barber has had to cancel your confirmed appointment.",
      "",
      ...bookingFacts(booking, customer.name, barber.name, timeZone),
      "",
      "We're sorry for the inconvenience -- you're welcome to book another time.",
      "",
      "VEYRON",
    ].join("\n"),
    dedupeKey: `booking:cancelled_by_barber:${booking._id}`,
  });

const notifyBookingCompleted = (booking, customer, barber, timeZone) =>
  notify({
    user: customer,
    type: "booking_completed",
    title: "Appointment completed",
    message: `Your appointment with ${barber.name} is complete. Thanks for booking with VEYRON.`,
    link: "/my-bookings",
    subject: "Your VEYRON appointment is complete",
    text: [
      `Hello ${customer.name},`,
      "",
      "Your appointment is now marked as completed.",
      "",
      ...bookingFacts(booking, customer.name, barber.name, timeZone),
      "",
      "VEYRON",
    ].join("\n"),
    dedupeKey: `booking:completed:${booking._id}`,
  });

const notifyBookingRescheduled = (booking, customer, barber, timeZone) =>
  Promise.all([
    notify({
      user: customer,
      type: "booking_confirmed",
      title: "Booking rescheduled",
      message: `Your appointment with ${barber.name} was moved to a new time.`,
      link: "/my-bookings",
      subject: "Your VEYRON booking was rescheduled",
      text: [
        `Hello ${customer.name},`,
        "",
        "Your appointment has been moved to a new time.",
        "",
        ...bookingFacts(booking, customer.name, barber.name, timeZone),
        "",
        "VEYRON",
      ].join("\n"),
      dedupeKey: `booking:rescheduled:customer:${booking._id}:${booking.startAt.toISOString()}`,
    }),
    notify({
      user: barber,
      type: "booking_confirmed",
      title: "Booking rescheduled",
      message: `An appointment with ${customer.name} was moved to a new time.`,
      link: "/barber/appointments",
      subject: "A VEYRON booking was rescheduled",
      text: [
        `Hello ${barber.name},`,
        "",
        "An appointment has been moved to a new time.",
        "",
        ...bookingFacts(booking, customer.name, barber.name, timeZone),
        "",
        "VEYRON",
      ].join("\n"),
      dedupeKey: `booking:rescheduled:barber:${booking._id}:${booking.startAt.toISOString()}`,
    }),
  ]);

/**
 * A reminder ahead of the appointment. Not fired automatically by any
 * request in this app -- there is no background job runner here, so
 * something outside the request/response cycle has to call this. See
 * scripts/sendBookingReminders.js, meant to be run on a schedule (cron /
 * Windows Task Scheduler / a hosting platform's scheduled job feature).
 */
const notifyBookingReminder = (booking, customer, barber, timeZone) =>
  notify({
    user: customer,
    type: "booking_reminder",
    title: "Upcoming appointment",
    message: `Reminder: your appointment with ${barber.name} is coming up.`,
    link: "/my-bookings",
    subject: "Reminder: your upcoming VEYRON appointment",
    text: [
      `Hello ${customer.name},`,
      "",
      "This is a reminder about your upcoming appointment.",
      "",
      ...bookingFacts(booking, customer.name, barber.name, timeZone),
      "",
      "VEYRON",
    ].join("\n"),
    // Bucketed by day so a reminder script run more than once in a day
    // for the same booking cannot double-send.
    dedupeKey: `booking:reminder:${booking._id}:${new Date().toISOString().slice(0, 10)}`,
  });

module.exports = {
  notify,
  notifyEmailVerified,
  notifyPasswordChanged,
  notifySuspiciousLogin,
  notifyBarberApplicationReceived,
  notifyAdminNewBarberApplication,
  notifyBarberApproved,
  notifyBarberRejected,
  notifyBarberSuspended,
  notifyBarberReactivated,
  notifyBookingCreated,
  notifyBookingConfirmed,
  notifyBookingRejected,
  notifyBookingCancelledByCustomer,
  notifyBookingCancelledByBarber,
  notifyBookingCompleted,
  notifyBookingRescheduled,
  notifyBookingReminder,
};
