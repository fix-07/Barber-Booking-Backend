const Booking = require("../models/Booking");
const Service = require("../models/Service");
const BarberProfile = require("../models/BarberProfile");
const User = require("../models/User");
const { fitsWorkingHours } = require("../utils/schedule");
const { findOrCreateWalkInCustomer } = require("../utils/walkInUser");
const { readPaging } = require("../utils/queryHelpers");
const { recordAudit } = require("../utils/auditLog");
const { notifyBookingRescheduled } = require("../services/notificationService");

/**
 * Every route in this file is mounted behind requireAuth + requireRole("admin")
 * in server.js -- see the comment there for why that is done once at the
 * mount point rather than repeated on each route.
 *
 * Reuses Booking's existing findOverlap-shaped query, fitsWorkingHours, and
 * the same unique-index race-condition safety net as the public booking
 * flow in bookingController.js createBooking -- an admin-created booking is
 * a real booking and must be exactly as safe against double-booking as a
 * customer's.
 */

const findOverlap = ({ barberId, startAt, endAt, excludeBookingId }) => {
  const query = {
    barber: barberId,
    holdsSlot: true,
    startAt: { $lt: endAt },
    endAt: { $gt: startAt },
  };
  if (excludeBookingId) query._id = { $ne: excludeBookingId };
  return Booking.findOne(query);
};

const TERMINAL_STATUSES = [
  "completed",
  "no_show",
  "cancelled_by_customer",
  "cancelled_by_barber",
  "cancelled_by_admin",
];

/**
 * GET /api/admin/bookings
 * Every booking in the shop, not just one person's -- the thing that does
 * not exist anywhere else in this codebase (every other list is
 * ownership-filtered to req.user._id).
 */
const listAllBookings = async (req, res) => {
  // maxLimit is higher than other admin lists: the calendar's month view
  // asks for every booking in a 6-week grid in one request rather than
  // paginating a single barber's schedule.
  const { page, limit, skip } = readPaging(req.query, { defaultLimit: 20, maxLimit: 500 });
  const { date, from, to, barberId, serviceId, status, paymentStatus } = req.query;

  const filter = {};

  if (barberId) filter.barber = barberId;
  if (serviceId) filter.service = serviceId;
  if (status && Booking.BOOKING_STATUSES.includes(status)) filter.status = status;
  if (paymentStatus) filter["payment.status"] = paymentStatus;

  // A simple UTC calendar-day (or day-range) filter. This is deliberately
  // less precise than the shop-timezone-aware logic in getAvailability --
  // it is a list filter for staff looking at "today" or "this week", not a
  // booking-time safety check. `from`/`to` (used by the calendar's week and
  // month views) take priority over a single `date` if both are somehow
  // sent.
  if (from && to && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    filter.startAt = {
      $gte: new Date(`${from}T00:00:00.000Z`),
      $lt: new Date(`${to}T00:00:00.000Z`),
    };
  } else if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const dayStart = new Date(`${date}T00:00:00.000Z`);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    filter.startAt = { $gte: dayStart, $lt: dayEnd };
  }

  const [bookings, total] = await Promise.all([
    Booking.find(filter)
      .populate("customer", "name phone email")
      .populate("barber", "name")
      .sort({ startAt: -1 })
      .skip(skip)
      .limit(limit),
    Booking.countDocuments(filter),
  ]);

  res.status(200).json({
    bookings: bookings.map((booking) => booking.toJSONFor("admin")),
    page,
    limit,
    total,
  });
};

/**
 * GET /api/admin/bookings/:id
 */
const getBookingAsAdmin = async (req, res) => {
  const booking = await Booking.findById(req.params.id)
    .populate("customer", "name phone email")
    .populate("barber", "name");

  if (!booking) {
    return res.status(404).json({ errors: [{ message: "Booking not found" }] });
  }

  res.status(200).json({ booking: booking.toJSONFor("admin") });
};

/**
 * POST /api/admin/bookings
 * Records a walk-in or phone booking. See utils/walkInUser.js for how the
 * customer side is resolved.
 *
 * DELIBERATELY NOT CHECKED HERE, UNLIKE THE CUSTOMER-FACING createBooking:
 * profile.isPublished / profile.isAcceptingBookings. Those two flags exist
 * to control public self-service visibility. Staff creating a booking for a
 * real client of a real barber who works there is a different situation --
 * what must NOT be bypassed is whether the barber is actually free, which
 * is exactly what fitsWorkingHours and the overlap/unique-index checks
 * below still enforce in full.
 */
const adminCreateBooking = async (req, res) => {
  const {
    serviceId,
    barberId,
    startAt,
    existingUserId,
    name,
    email,
    phone,
    staffNote,
  } = req.body;

  const service = await Service.findOne({
    _id: serviceId,
    barber: barberId,
    isActive: true,
  });
  if (!service) {
    return res.status(404).json({ errors: [{ message: "That service is not available" }] });
  }

  const barber = await User.findOne({ _id: barberId, role: "barber" });
  if (!barber) {
    return res.status(404).json({ errors: [{ message: "That barber could not be found" }] });
  }

  const profile = await BarberProfile.findOne({ user: barberId });
  if (!profile) {
    return res.status(409).json({
      errors: [{ message: "That barber has not set up a shop profile yet" }],
    });
  }

  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) {
    return res.status(400).json({ errors: [{ message: "That is not a valid date and time", path: "startAt" }] });
  }

  const end = new Date(start.getTime() + service.durationMinutes * 60000);

  const hoursCheck = fitsWorkingHours({
    startAt: start,
    endAt: end,
    timeZone: profile.timeZone,
    workingHours: profile.workingHours,
    timeOff: profile.timeOff,
  });
  if (!hoursCheck.ok) {
    return res.status(409).json({ errors: [{ message: hoursCheck.reason }] });
  }

  const clash = await findOverlap({ barberId, startAt: start, endAt: end });
  if (clash) {
    return res.status(409).json({ errors: [{ message: "The barber already has an appointment at that time" }] });
  }

  let customer;
  try {
    customer = await findOrCreateWalkInCustomer({ existingUserId, name, email, phone });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ errors: [{ message: error.message }] });
  }

  try {
    const booking = await Booking.create({
      customer: customer._id,
      barber: barberId,
      service: service._id,
      startAt: start,
      endAt: end,
      status: "confirmed", // staff booking it in means it is already agreed
      serviceNameAtBooking: service.name,
      durationMinutesAtBooking: service.durationMinutes,
      priceMinorAtBooking: service.priceMinor,
      currencyAtBooking: service.currency,
      staffNote: staffNote || "",
    });

    const populated = await booking.populate([
      { path: "customer", select: "name phone email" },
      { path: "barber", select: "name" },
    ]);

    return res.status(201).json({
      message: "Booking created.",
      booking: populated.toJSONFor("admin"),
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ errors: [{ message: "The barber already has an appointment at that time" }] });
    }
    throw error;
  }
};

/**
 * PATCH /api/admin/bookings/:id/status
 * Unlike bookingController.updateBookingStatus (barber-only, ownership-
 * filtered, restricted to BARBER_ALLOWED_TRANSITIONS), staff can move a
 * booking to any status. Setting it to cancelled_by_admin also records the
 * cancellation the same way the customer/barber cancel paths do.
 */
const adminUpdateStatus = async (req, res) => {
  const { status, reason } = req.body;

  const booking = await Booking.findById(req.params.id);
  if (!booking) {
    return res.status(404).json({ errors: [{ message: "Booking not found" }] });
  }

  booking.status = status;

  if (status === "cancelled_by_admin") {
    booking.cancelledAt = new Date();
    booking.cancelledBy = "admin";
    booking.cancellationReason = reason || "";
  }

  try {
    await booking.save();
  } catch (error) {
    // Moving a cancelled/completed booking back to a slot-holding status can
    // collide with something booked into that slot afterwards -- the same
    // database-level guard createBooking relies on catches it here too.
    if (error.code === 11000) {
      return res.status(409).json({
        errors: [{ message: "That slot is no longer free -- another appointment now occupies it." }],
      });
    }
    throw error;
  }

  const populated = await booking.populate([
    { path: "customer", select: "name phone email" },
    { path: "barber", select: "name" },
  ]);

  res.status(200).json({ message: "Booking updated.", booking: populated.toJSONFor("admin") });
};

/**
 * PATCH /api/admin/bookings/:id/reschedule
 */
const adminReschedule = async (req, res) => {
  const { startAt } = req.body;

  const booking = await Booking.findById(req.params.id);
  if (!booking) {
    return res.status(404).json({ errors: [{ message: "Booking not found" }] });
  }

  if (TERMINAL_STATUSES.includes(booking.status)) {
    return res.status(409).json({
      errors: [{ message: `A booking that is "${booking.status}" cannot be rescheduled.` }],
    });
  }

  const profile = await BarberProfile.findOne({ user: booking.barber });
  if (!profile) {
    return res.status(409).json({ errors: [{ message: "That barber has no shop profile" }] });
  }

  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) {
    return res.status(400).json({ errors: [{ message: "That is not a valid date and time", path: "startAt" }] });
  }
  const end = new Date(start.getTime() + booking.durationMinutesAtBooking * 60000);

  const hoursCheck = fitsWorkingHours({
    startAt: start,
    endAt: end,
    timeZone: profile.timeZone,
    workingHours: profile.workingHours,
    timeOff: profile.timeOff,
  });
  if (!hoursCheck.ok) {
    return res.status(409).json({ errors: [{ message: hoursCheck.reason }] });
  }

  const clash = await findOverlap({
    barberId: booking.barber,
    startAt: start,
    endAt: end,
    excludeBookingId: booking._id,
  });
  if (clash) {
    return res.status(409).json({ errors: [{ message: "The barber already has an appointment at that time" }] });
  }

  booking.startAt = start;
  booking.endAt = end;

  try {
    await booking.save();
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ errors: [{ message: "That time has just been taken. Please choose another slot" }] });
    }
    throw error;
  }

  const populated = await booking.populate([
    { path: "customer", select: "name phone email" },
    { path: "barber", select: "name email" },
  ]);

  if (populated.customer && populated.barber) {
    const barberProfile = await BarberProfile.findOne({ user: populated.barber._id }).select("timeZone");
    try {
      await notifyBookingRescheduled(
        populated,
        populated.customer,
        populated.barber,
        barberProfile ? barberProfile.timeZone : undefined
      );
    } catch (error) {
      console.error("Reschedule notification failed:", error.message);
    }
  }

  res.status(200).json({ message: "Booking rescheduled.", booking: populated.toJSONFor("admin") });
};

/**
 * PATCH /api/admin/bookings/:id/payment
 */
const recordPayment = async (req, res) => {
  const { status, method } = req.body;

  const booking = await Booking.findById(req.params.id);
  if (!booking) {
    return res.status(404).json({ errors: [{ message: "Booking not found" }] });
  }

  booking.payment = {
    status,
    method: method || null,
    recordedAt: new Date(),
    recordedBy: req.user._id,
  };

  await booking.save();

  const populated = await booking.populate([
    { path: "customer", select: "name phone email" },
    { path: "barber", select: "name" },
  ]);

  res.status(200).json({ message: "Payment recorded.", booking: populated.toJSONFor("admin") });
};

/**
 * DELETE /api/admin/bookings/:id
 * A REAL, permanent delete -- the Booking document is removed from the
 * database entirely. Explicitly requested and confirmed by VEYRON admin
 * even though it means this booking's revenue/count drops out of
 * Analytics, Calendar history and Revenue reports once it's gone -- unlike
 * "Cancel" (PATCH /:id/status with cancelled_by_admin), which keeps the
 * record and is the right choice for "this didn't happen but we still want
 * it on the books as cancelled". Both actions exist side by side in the
 * admin UI; this is the destructive one.
 *
 * Nothing else in the schema hard-references a booking the way Booking
 * itself hard-references a service/barber/customer -- Review.booking is an
 * optional pointer used only for display (see models/Review.js), so no
 * cleanup is needed elsewhere when one is removed.
 */
const deleteBooking = async (req, res) => {
  const booking = await Booking.findById(req.params.id);
  if (!booking) {
    return res.status(404).json({ errors: [{ message: "Booking not found" }] });
  }

  await booking.deleteOne();

  await recordAudit(req, {
    action: "booking.delete",
    resourceType: "booking",
    resourceId: booking._id,
    summary: `Permanently deleted booking: ${booking.serviceNameAtBooking} on ${booking.startAt.toISOString()}. Removed from history and analytics.`,
  });

  res.status(200).json({ message: "Booking permanently deleted." });
};

/**
 * DELETE /api/admin/bookings/:id/payment
 * Clears the payment record back to its never-recorded default -- unlike
 * "Mark unpaid" (still PATCH /payment with status:"unpaid"), which keeps a
 * paper trail of who reset it and when, this wipes method/recordedAt/
 * recordedBy too. There is no separate transactions collection to delete
 * from (see the model comment on Booking.payment); this is what "delete a
 * payment" means on this schema. The booking itself is untouched.
 */
const deletePayment = async (req, res) => {
  const booking = await Booking.findById(req.params.id);
  if (!booking) {
    return res.status(404).json({ errors: [{ message: "Booking not found" }] });
  }

  const clearedFrom = booking.payment?.status || "unpaid";
  booking.payment = { status: "unpaid", method: null, recordedAt: null, recordedBy: null };
  await booking.save();

  await recordAudit(req, {
    action: "payment.delete",
    resourceType: "payment",
    resourceId: booking._id,
    // Explicitly worded: this was not a refund, and the log should say so
    // plainly if anyone ever reads it back asking where money went.
    summary: `Cleared payment record (was "${clearedFrom}") on booking ${booking.serviceNameAtBooking}. No refund issued; booking untouched.`,
  });

  const populated = await booking.populate([
    { path: "customer", select: "name phone email" },
    { path: "barber", select: "name" },
  ]);

  res.status(200).json({ message: "Payment record deleted.", booking: populated.toJSONFor("admin") });
};

module.exports = {
  listAllBookings,
  getBookingAsAdmin,
  adminCreateBooking,
  adminUpdateStatus,
  adminReschedule,
  recordPayment,
  deletePayment,
  deleteBooking,
};
