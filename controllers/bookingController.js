const Booking = require("../models/Booking");
const Service = require("../models/Service");
const BarberProfile = require("../models/BarberProfile");
const User = require("../models/User");
const {
  fitsWorkingHours,
  timeToMinutes,
  zonedWallTimeToUtc,
  parseDateOnly,
  getLocalDayAndMinutes,
  isDateInTimeOff,
} = require("../utils/schedule");
const {
  notifyBookingCreated,
  notifyBookingConfirmed,
  notifyBookingRejected,
  notifyBookingCancelledByCustomer,
  notifyBookingCancelledByBarber,
  notifyBookingCompleted,
} = require("../services/notificationService");

/**
 * A notification failure must never fail the booking action itself -- the
 * booking already saved by the time any of these run. See
 * services/notificationService.js's own internal handling for how an
 * email failure specifically is caught, logged and recorded; this is only
 * the outer guard against something going wrong in the notification code
 * itself.
 */
const safeNotify = async (fn) => {
  try {
    await fn();
  } catch (error) {
    console.error("Booking notification failed:", error.message);
  }
};

// How far ahead someone may book. Stops a bot filling your calendar for
// the year 2190, which would be impossible to clean up by hand.
const MAX_DAYS_AHEAD = 180;

// Slot spacing shown on the availability screen, in minutes.
const SLOT_STEP_MINUTES = 15;

/**
 * Which status changes a barber is allowed to make, and from where.
 *
 * WHY A MAP INSTEAD OF A PILE OF if STATEMENTS:
 * It makes the rules readable in one glance, and it makes the rules
 * COMPLETE. Anything not listed is refused by default, so a status we add
 * later cannot accidentally become reachable from everywhere.
 */
const BARBER_ALLOWED_TRANSITIONS = {
  pending: ["confirmed", "cancelled_by_barber"],
  confirmed: ["completed", "no_show", "cancelled_by_barber"],
  // These are final. Nothing may move out of them.
  completed: [],
  no_show: [],
  cancelled_by_customer: [],
  cancelled_by_barber: [],
};

/**
 * Finds any live booking for this barber that overlaps the requested window.
 *
 * THE OVERLAP TEST, in plain terms:
 * Two time ranges overlap if one starts before the other ends, AND ends
 * after the other starts. Written as a query:
 *     existing.startAt < newEnd  AND  existing.endAt > newStart
 *
 * Using strictly-less and strictly-greater (not <= and >=) is deliberate:
 * a booking that ends exactly at 10:00 does NOT clash with one starting at
 * 10:00. Back-to-back appointments are normal and must stay allowed.
 */
const findOverlap = ({ barberId, startAt, endAt, excludeBookingId }) => {
  const query = {
    barber: barberId,
    holdsSlot: true, // cancelled bookings free the slot
    startAt: { $lt: endAt },
    endAt: { $gt: startAt },
  };

  if (excludeBookingId) query._id = { $ne: excludeBookingId };

  return Booking.findOne(query);
};

/**
 * POST /api/bookings
 * Customer only.
 */
const createBooking = async (req, res) => {
  const { serviceId, startAt, customerNote } = req.body;

  // --- 0. The customer must be reachable ------------------------------
  // Real enforcement of the "phone required" rule for a Google account
  // that has not yet completed its profile (see models/User.js and
  // controllers/googleAuthController.js). Every LOCAL account already has
  // a phone number by the time it exists at all, so this only ever
  // actually refuses a Google sign-in that skipped /complete-profile --
  // the client-side redirect there (see auth/roleRoutes.js) is a
  // courtesy, this is the rule.
  if (!req.user.phone) {
    return res.status(400).json({
      errors: [{
        message: "Add a phone number to your account before booking, so your barber can reach you.",
      }],
    });
  }

  // --- 1. The service must exist and be on offer ---------------------
  const service = await Service.findOne({ _id: serviceId, isActive: true });
  if (!service) {
    return res.status(404).json({errors : [{message: "That service is not available"}]});
  }

  // --- 2. The barber must be published, approved and taking bookings -
  // NOTE: the barber id comes from the SERVICE record, not from the
  // request. The customer chooses a service; who owns it is not theirs
  // to decide.
  const profile = await BarberProfile.findOne({
    user: service.barber,
    isPublished: true,
  });

  if (!profile) {
    return res.status(404).json({errors : [{message: "That barber is not available"}]});
  }

  // Defense in depth alongside listPublicBarbers/getPublicBarber's own
  // status check: a barber who is pending approval, rejected or suspended
  // must never be bookable, even if their profile is somehow still
  // isPublished (approve/suspend/reject all also flip isPublished, but this
  // does not rely on that staying true forever). See requireActiveBarber in
  // middleware/auth.js for the matching dashboard-side gate.
  const barberUser = await User.findOne({ _id: service.barber, role: "barber", status: "active" });
  if (!barberUser) {
    return res.status(404).json({errors : [{message: "That barber is not available"}]});
  }

  if (!profile.isAcceptingBookings) {
    return res.status(409).json({errors : [{message: "This barber is not accepting new bookings at the moment"}]});
  }

  // A barber cannot book their own chair.
  if (String(service.barber) === String(req.user._id)) {
    return res.status(400).json({errors : [{message: "You cannot book an appointment with yourself"}]});
  }

  // --- 3. The requested time must be a real, sensible moment ----------
  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) {
    return res.status(400).json({errors : [{message: 'That is not a valid date and time', path : 'startAt'}]})
  }

  const now = new Date();
  if (start <= now) {
    return res.status(400).json({errors : [{message: 'Please choose a time in the future', path : 'startAt'}]})
  }

  const latestAllowed = new Date(
    now.getTime() + MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000
  );
  if (start > latestAllowed) {
    return res.status(400).json({errors : [{message: `Bookings can only be made up to ${MAX_DAYS_AHEAD} days ahead`, path : 'startAt'}]})
  }

  // The end time is CALCULATED from the service duration. We never accept
  // an endAt from the request: a customer could otherwise send a 5-minute
  // window for a 45-minute haircut and block far less of the barber's day
  // than the appointment actually takes.
  const end = new Date(start.getTime() + service.durationMinutes * 60000);

  // --- 4. It must fall inside the shop's opening hours ---------------
  const hoursCheck = fitsWorkingHours({
    startAt: start,
    endAt: end,
    timeZone: profile.timeZone,
    workingHours: profile.workingHours,
  });

  if (!hoursCheck.ok) {
    return res.status(409).json({errors : [{message: hoursCheck.reason}]});
  }

  // --- 5. The barber must be free -----------------------------------
  const clash = await findOverlap({
    barberId: service.barber,
    startAt: start,
    endAt: end,
  });

  if (clash) {
    return res.status(409).json({errors : [{message: "That time has just been taken. Please choose another slot"}]});
  }

  // --- 6. The customer must not double-book themselves --------------
  // Without this, one person could hold three barbers at 10:00 and keep
  // whichever they felt like, wasting the other two slots.
  const ownClash = await Booking.findOne({
    customer: req.user._id,
    holdsSlot: true,
    startAt: { $lt: end },
    endAt: { $gt: start },
  });

  if (ownClash) {
    return res.status(409).json({errors : [{message: "You already have another appointment at that time"}]});
  }

  // --- 7. Save, with the price and duration snapshotted --------------
  try {
    const booking = await Booking.create({
      customer: req.user._id, // from the verified token, never the body
      barber: service.barber,
      service: service._id,
      startAt: start,
      endAt: end,
      status: "pending",
      serviceNameAtBooking: service.name,
      durationMinutesAtBooking: service.durationMinutes,
      priceMinorAtBooking: service.priceMinor,
      currencyAtBooking: service.currency,
      customerNote: customerNote || "",
    });

    // Fire-and-log, not fire-and-await-blocking: the booking already
    // exists, so the HTTP response goes back to the customer immediately
    // rather than waiting on two outbound emails first. A failure inside
    // is caught by safeNotify and can never surface as a failed booking.
    const barberUser = await User.findById(service.barber).select("name email");
    if (barberUser) {
      safeNotify(() =>
        notifyBookingCreated(booking, req.user, barberUser, profile.timeZone)
      );
    }

    return res.status(201).json({
      message: "Appointment requested. The barber will confirm it.",
      booking: booking.toJSONFor("customer"),
    });
  } catch (error) {
    // Error 11000 is the unique index on (barber, startAt) firing. That
    // means another customer saved the same slot in the split second
    // between our check in step 5 and this save. The database caught the
    // race our code could not, which is exactly why that index exists.
    if (error.code === 11000) {
      return res.status(409).json({errors : [{message: "That time has just been taken. Please choose another slot"}]});
    }
    throw error; // anything else goes to the central error handler
  }
};

/**
 * GET /api/bookings/mine
 * Customer only. Their OWN bookings.
 */
const listMyBookings = async (req, res) => {
  // OWNERSHIP: hard-filtered to the logged-in customer. There is no way
  // to widen this filter from the request.
  const filter = { customer: req.user._id };

  if (req.query.upcoming === "true") {
    filter.startAt = { $gte: new Date() };
    filter.holdsSlot = true;
  }

  const bookings = await Booking.find(filter)
    .populate("barber", "name")
    .sort({ startAt: -1 })
    .limit(200);

  res.status(200).json({
    bookings: bookings.map((booking) => booking.toJSONFor("customer")),
  });
};

/**
 * GET /api/bookings/appointments
 * Barber only. Their OWN appointments.
 */
const listMyAppointments = async (req, res) => {
  const filter = { barber: req.user._id };

  if (req.query.upcoming === "true") {
    filter.startAt = { $gte: new Date() };
    filter.holdsSlot = true;
  }

  const bookings = await Booking.find(filter)
    .populate("customer", "name phone")
    .sort({ startAt: 1 })
    .limit(200);

  res.status(200).json({
    bookings: bookings.map((booking) => booking.toJSONFor("barber")),
  });
};

/**
 * GET /api/bookings/:id
 * The customer who made it, or the barber it is with. Nobody else.
 *
 * THE OWNERSHIP CHECK:
 * The query asks for a booking with this id where the logged-in user is
 * EITHER the customer OR the barber. Anyone else gets null, and therefore
 * a 404 that does not confirm the booking exists.
 */
const getBooking = async (req, res) => {
  const booking = await Booking.findOne({
    _id: req.params.id,
    $or: [{ customer: req.user._id }, { barber: req.user._id }],
  })
    .populate("customer", "name phone")
    .populate("barber", "name");

  if (!booking) {
    return res.status(404).json({errors : [{message: "Booking not found"}]});
  }

  // Show each side the view appropriate to them.
  const viewerRole =
    String(booking.customer._id || booking.customer) === String(req.user._id)
      ? "customer"
      : "barber";

  res.status(200).json({ booking: booking.toJSONFor(viewerRole) });
};

/**
 * PATCH /api/bookings/:id/cancel
 * Either side may cancel, but only their own booking.
 */
const cancelBooking = async (req, res) => {
  const booking = await Booking.findOne({
    _id: req.params.id,
    $or: [{ customer: req.user._id }, { barber: req.user._id }],
  });

  if (!booking) {
    return res.status(404).json({errors : [{message: "Booking not found"}]});
  }

  // We work out which side is cancelling from the verified token, not from
  // anything the request claims. This matters because the two cancellation
  // statuses may carry different refund consequences.
  const isCustomer =
    String(booking.customer) === String(req.user._id);

  if (booking.isCancelled()) {
    return res.status(409).json({errors : [{message: "This booking is already cancelled"}]});
  }

  if (booking.status === "completed" || booking.status === "no_show") {
    return res.status(409).json({errors : [{message: "This appointment has already happened and cannot be cancelled"}]});
  }

  booking.status = isCustomer
    ? "cancelled_by_customer"
    : "cancelled_by_barber";
  booking.cancelledAt = new Date();
  booking.cancelledBy = isCustomer ? "customer" : "barber";
  // req.body can be undefined: express.json() only populates it when the
  // request carries a JSON Content-Type, and a real cancel click sends none.
  booking.cancellationReason = (req.body && req.body.reason) || "";

  // The pre("validate") hook sets holdsSlot to false, which frees the slot
  // and releases the unique index so the time can be booked again.
  await booking.save();

  // Tell the OTHER side -- whoever did not just click Cancel already knows.
  const [customerUser, barberUser, barberProfile] = await Promise.all([
    User.findById(booking.customer).select("name email"),
    User.findById(booking.barber).select("name email"),
    BarberProfile.findOne({ user: booking.barber }).select("timeZone"),
  ]);
  if (customerUser && barberUser) {
    const timeZone = barberProfile ? barberProfile.timeZone : undefined;
    safeNotify(() =>
      isCustomer
        ? notifyBookingCancelledByCustomer(booking, customerUser, barberUser, timeZone)
        : notifyBookingCancelledByBarber(booking, customerUser, barberUser, timeZone)
    );
  }

  res.status(200).json({
    message: "Booking cancelled.",
    booking: booking.toJSONFor(isCustomer ? "customer" : "barber"),
  });
};

/**
 * PATCH /api/bookings/:id/status
 * Barber only, and only for their OWN appointments.
 *
 * This is how a barber confirms a request, marks it done, or records a
 * no-show.
 */
const updateBookingStatus = async (req, res) => {
  const { status } = req.body;

  const booking = await Booking.findOne({
    _id: req.params.id,
    barber: req.user._id, // ownership, from the token
  });

  if (!booking) {
    return res.status(404).json({errors : [{message: "Booking not found"}]});
  }

  const allowed = BARBER_ALLOWED_TRANSITIONS[booking.status] || [];

  if (!allowed.includes(status)) {
    return res.status(409).json({
      errors : [{message: `A booking that is "${booking.status}" cannot be changed to "${status}"`, path : 'status'}],
      allowedNext : allowed
    })
  }

  // Needed to tell "declined a pending request" apart from "cancelled an
  // already-confirmed one" below -- both land on the same status value.
  const previousStatus = booking.status;

  booking.status = status;

  if (status === "cancelled_by_barber") {
    booking.cancelledAt = new Date();
    booking.cancelledBy = "barber";
    // req.body can be undefined: express.json() only populates it when the
    // request carries a JSON Content-Type.
    booking.cancellationReason = (req.body && req.body.reason) || "";
  }

  await booking.save();

  const [customerUser, barberUser, barberProfile] = await Promise.all([
    User.findById(booking.customer).select("name email"),
    User.findById(booking.barber).select("name email"),
    BarberProfile.findOne({ user: booking.barber }).select("timeZone"),
  ]);

  if (customerUser && barberUser) {
    const timeZone = barberProfile ? barberProfile.timeZone : undefined;

    if (status === "confirmed") {
      safeNotify(() => notifyBookingConfirmed(booking, customerUser, barberUser, timeZone));
    } else if (status === "cancelled_by_barber" && previousStatus === "pending") {
      safeNotify(() => notifyBookingRejected(booking, customerUser, barberUser, timeZone));
    } else if (status === "cancelled_by_barber") {
      safeNotify(() => notifyBookingCancelledByBarber(booking, customerUser, barberUser, timeZone));
    } else if (status === "completed") {
      safeNotify(() => notifyBookingCompleted(booking, customerUser, barberUser, timeZone));
    }
    // "no_show" deliberately has no customer-facing email -- there is
    // nothing to tell someone who did not attend that they do not
    // already know.
  }

  res.status(200).json({
    message: "Booking updated.",
    booking: booking.toJSONFor("barber"),
  });
};

/**
 * GET /api/bookings/availability?barberId=...&serviceId=...&date=YYYY-MM-DD
 * PUBLIC, so a visitor can see free times before creating an account.
 *
 * WHAT IT DELIBERATELY DOES NOT REVEAL:
 * Only "this time is free" or "this time is not free". It never says who
 * booked a taken slot, or what service they booked. A visitor can tell
 * when a barber is busy, which is unavoidable for any booking site, but
 * learns nothing about the other customers.
 */
const getAvailability = async (req, res) => {
  const { barberId, serviceId, date } = req.query;

  const parsedDate = parseDateOnly(date);
  if (!parsedDate) {
    return res.status(400).json({errors : [{message: 'Use the format YYYY-MM-DD, for example 2026-06-01', path : 'date'}]})
  }

  const service = await Service.findOne({
    _id: serviceId,
    barber: barberId,
    isActive: true,
  });

  if (!service) {
    return res.status(404).json({errors : [{message: "That service is not available"}]});
  }

  const profile = await BarberProfile.findOne({
    user: barberId,
    isPublished: true,
  });

  if (!profile) {
    return res.status(404).json({errors : [{message: "That barber is not available"}]});
  }

  // See the matching check in createBooking above for why this is checked
  // independently of isPublished.
  const barberUser = await User.findOne({ _id: barberId, role: "barber", status: "active" });
  if (!barberUser) {
    return res.status(404).json({errors : [{message: "That barber is not available"}]});
  }

  // Which weekday is that calendar date, in the shop's own timezone?
  const middayLocal = zonedWallTimeToUtc(
    parsedDate.year,
    parsedDate.month,
    parsedDate.day,
    12,
    0,
    profile.timeZone
  );

  const { day } = getLocalDayAndMinutes(middayLocal, profile.timeZone);

  const rule = (profile.workingHours || []).find((entry) => entry.day === day);

  // `date` is already the shop's own local calendar date -- that is the
  // entire premise of this endpoint -- so it doubles as the time-off lookup
  // key with no extra conversion. See getLocalDateKey in utils/schedule.js
  // for why time off is compared as a date string, not a Date.
  const onTimeOff = isDateInTimeOff(date, profile.timeOff);

  if (!rule || !rule.isOpen || !profile.isAcceptingBookings || onTimeOff) {
    return res.status(200).json({
      date,
      timeZone: profile.timeZone,
      durationMinutes: service.durationMinutes,
      slots: [],
      closed: true,
    });
  }

  const opensAt = timeToMinutes(rule.open);
  const closesAt = timeToMinutes(rule.close);
  const breakStartAt = rule.breakStart ? timeToMinutes(rule.breakStart) : null;
  const breakEndAt = rule.breakEnd ? timeToMinutes(rule.breakEnd) : null;

  // Build the full day's window once, then fetch everything already booked
  // inside it in ONE query. Querying per slot would mean dozens of database
  // round trips for a single page load.
  const dayStart = zonedWallTimeToUtc(
    parsedDate.year, parsedDate.month, parsedDate.day,
    Math.floor(opensAt / 60), opensAt % 60,
    profile.timeZone
  );
  const dayEnd = zonedWallTimeToUtc(
    parsedDate.year, parsedDate.month, parsedDate.day,
    Math.floor(closesAt / 60), closesAt % 60,
    profile.timeZone
  );

  const existing = await Booking.find({
    barber: barberId,
    holdsSlot: true,
    startAt: { $lt: dayEnd },
    endAt: { $gt: dayStart },
  }).select("startAt endAt");

  const now = new Date();
  const slots = [];

  for (
    let minute = opensAt;
    minute + service.durationMinutes <= closesAt;
    minute += SLOT_STEP_MINUTES
  ) {
    const slotStart = zonedWallTimeToUtc(
      parsedDate.year, parsedDate.month, parsedDate.day,
      Math.floor(minute / 60), minute % 60,
      profile.timeZone
    );
    const slotEnd = new Date(
      slotStart.getTime() + service.durationMinutes * 60000
    );

    if (slotStart <= now) continue; // no booking in the past

    // Skip anything overlapping the day's break, if one is set. Same
    // strictly-less/-greater overlap test used everywhere else in this
    // file for appointments.
    if (
      breakStartAt !== null &&
      breakEndAt !== null &&
      minute < breakEndAt &&
      minute + service.durationMinutes > breakStartAt
    ) {
      continue;
    }

    const taken = existing.some(
      (booking) => booking.startAt < slotEnd && booking.endAt > slotStart
    );

    slots.push({
      startAt: slotStart.toISOString(),
      endAt: slotEnd.toISOString(),
      available: !taken,
    });
  }

  res.status(200).json({
    date,
    timeZone: profile.timeZone,
    durationMinutes: service.durationMinutes,
    slots,
    closed: false,
  });
};

module.exports = {
  createBooking,
  listMyBookings,
  listMyAppointments,
  getBooking,
  cancelBooking,
  updateBookingStatus,
  getAvailability,
};
