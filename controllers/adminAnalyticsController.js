const Booking = require("../models/Booking");
const User = require("../models/User");
const BarberProfile = require("../models/BarberProfile");
const Review = require("../models/Review");

const DAY_MS = 24 * 60 * 60 * 1000;

const startOfUtcDay = (date) => {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

const RANGE_DAYS = { today: 1, "7d": 7, "30d": 30, "90d": 90 };

/**
 * Percentage change from `previous` to `current`, or null when there is
 * nothing honest to compare against (previous period had zero) -- returning
 * 0% or an invented "+100%" would both misrepresent going from nothing to
 * something. The frontend shows no comparison badge when this is null.
 */
const percentChange = (current, previous) => {
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
};

/**
 * Returns the most frequently used currency among an array of booking
 * documents that have a `currencyAtBooking` field, or null when the array
 * is empty. Used so the dashboard can display the correct symbol (£, €, $…)
 * without hardcoding GBP.  If the period contains mixed currencies the
 * result is the plurality winner; the caller should note that summing
 * amounts across currencies is only meaningful when they are all the same.
 */
const dominantCurrency = (bookings) => {
  if (!bookings.length) return null;
  const freq = {};
  for (const b of bookings) {
    const c = b.currencyAtBooking;
    if (c) freq[c] = (freq[c] || 0) + 1;
  }
  const entries = Object.entries(freq);
  if (!entries.length) return null;
  return entries.sort((a, b) => b[1] - a[1])[0][0];
};

/**
 * GET /api/admin/analytics/overview?range=today|7d|30d|90d
 *
 * Serves both the Overview dashboard (range=today) and the Analytics/
 * Reports page (any range) with one endpoint, since almost everything here
 * is "count/sum X within a window" and the window is the only thing that
 * changes -- see the plan note on why this is one endpoint, not two.
 *
 * EVERY NUMBER HERE COMES FROM A REAL QUERY. There is no seeded or made-up
 * data: a shop with no bookings yet gets zeros, not placeholder figures.
 *
 * "Revenue" specifically means money actually recorded as collected
 * (status "completed" AND payment.status "paid") -- not the value of
 * everything ever booked, which would overstate it. See Booking.payment
 * for why that field exists at all: there is no payment processor here,
 * staff record cash/card-in-person payment manually.
 */
const getOverview = async (req, res) => {
  const range = RANGE_DAYS[req.query.range] ? req.query.range : "today";
  const days = RANGE_DAYS[range];

  const now = new Date();
  const todayStart = startOfUtcDay(now);
  const todayEnd = new Date(todayStart.getTime() + DAY_MS);

  const rangeStart = new Date(todayEnd.getTime() - days * DAY_MS);
  const rangeEnd = todayEnd;

  const liveStatusFilter = { status: { $in: Booking.SLOT_HOLDING_STATUSES } };

  const yesterdayStart = new Date(todayStart.getTime() - DAY_MS);

  // --- snapshot counts: not scoped to the chosen range, always "right now" ---
  const [
    totalClients,
    activeBarbers,
    pendingBookingsCount,
    todaysBookingsCount,
    upcomingBookingsCount,
    todaysRevenueBookings,
    cancelledTodayCount,
    yesterdaysBookingsCount,
    yesterdaysRevenueBookings,
  ] = await Promise.all([
    User.countDocuments({ role: "customer" }),
    BarberProfile.countDocuments({ isPublished: true, isAcceptingBookings: true }),
    Booking.countDocuments({ status: "pending" }),
    Booking.countDocuments({ ...liveStatusFilter, startAt: { $gte: todayStart, $lt: todayEnd } }),
    Booking.countDocuments({ ...liveStatusFilter, startAt: { $gte: now } }),
    Booking.find({
      status: "completed",
      "payment.status": "paid",
      startAt: { $gte: todayStart, $lt: todayEnd },
    }).select("priceMinorAtBooking currencyAtBooking"),
    Booking.countDocuments({ cancelledAt: { $gte: todayStart, $lt: todayEnd } }),
    // Yesterday, for the KPI cards' "vs previous period" comparison.
    Booking.countDocuments({ ...liveStatusFilter, startAt: { $gte: yesterdayStart, $lt: todayStart } }),
    Booking.find({
      status: "completed",
      "payment.status": "paid",
      startAt: { $gte: yesterdayStart, $lt: todayStart },
    }).select("priceMinorAtBooking currencyAtBooking"),
  ]);

  const todaysRevenueMinor = todaysRevenueBookings.reduce(
    (sum, b) => sum + b.priceMinorAtBooking,
    0
  );
  const yesterdaysRevenueMinor = yesterdaysRevenueBookings.reduce(
    (sum, b) => sum + b.priceMinorAtBooking,
    0
  );

  // For the "vs previous period" comparison: the same length window
  // immediately before rangeStart.
  const previousRangeStart = new Date(rangeStart.getTime() - days * DAY_MS);

  // --- range-scoped metrics ---
  const [
    paidCompletedInRange,
    activeBookingsInRange,
    allBookingsInRange,
    cancelledInRange,
    activeCustomerIds,
    popularServices,
    barberPerformance,
    previousPaidCompleted,
    previousActiveBookings,
    dailySeriesRaw,
    recentPaymentsRaw,
    recentReviewsRaw,
  ] = await Promise.all([
    Booking.find({
      status: "completed",
      "payment.status": "paid",
      startAt: { $gte: rangeStart, $lt: rangeEnd },
    }).select("priceMinorAtBooking currencyAtBooking"),

    Booking.countDocuments({ ...liveStatusFilter, startAt: { $gte: rangeStart, $lt: rangeEnd } }),

    Booking.countDocuments({ startAt: { $gte: rangeStart, $lt: rangeEnd } }),

    Booking.countDocuments({
      startAt: { $gte: rangeStart, $lt: rangeEnd },
      status: { $in: ["cancelled_by_customer", "cancelled_by_barber", "cancelled_by_admin"] },
    }),

    Booking.distinct("customer", { ...liveStatusFilter, startAt: { $gte: rangeStart, $lt: rangeEnd } }),

    Booking.aggregate([
      { $match: { ...liveStatusFilter, startAt: { $gte: rangeStart, $lt: rangeEnd } } },
      { $group: { _id: "$serviceNameAtBooking", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 },
    ]),

    Booking.aggregate([
      { $match: { ...liveStatusFilter, startAt: { $gte: rangeStart, $lt: rangeEnd } } },
      {
        $group: {
          _id: "$barber",
          bookingsCount: { $sum: 1 },
          revenueMinor: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ["$status", "completed"] }, { $eq: ["$payment.status", "paid"] }] },
                "$priceMinorAtBooking",
                0,
              ],
            },
          },
          // A representative snapshot name from within this group, for when
          // the barber account has since been deleted -- see
          // adminBarberController.deleteBarber's barberNameAtBooking
          // backfill. Every booking by a deleted barber has this set.
          barberNameAtBooking: { $first: "$barberNameAtBooking" },
        },
      },
      { $sort: { revenueMinor: -1 } },
      {
        $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "barberDoc" },
      },
      // NOT $unwind: an empty $lookup array (the barber account was
      // deleted) makes $unwind drop the WHOLE group silently -- their real,
      // historical revenue would vanish from this breakdown even though
      // the headline total above still (correctly) includes it. Numbers
      // that stop adding up with no error is worse than a missing name.
      // $arrayElemAt + $ifNull instead: fall back to the booking-time
      // snapshot, then to a plain label, but the row itself always stays.
      {
        $project: {
          barberId: "$_id",
          barberName: {
            $ifNull: [
              { $arrayElemAt: ["$barberDoc.name", 0] },
              { $ifNull: ["$barberNameAtBooking", "Deleted barber"] },
            ],
          },
          bookingsCount: 1,
          revenueMinor: 1,
          _id: 0,
        },
      },
    ]),

    // Previous period, for percentChange below.
    Booking.find({
      status: "completed",
      "payment.status": "paid",
      startAt: { $gte: previousRangeStart, $lt: rangeStart },
    }).select("priceMinorAtBooking"),
    Booking.countDocuments({ ...liveStatusFilter, startAt: { $gte: previousRangeStart, $lt: rangeStart } }),

    // Always the trailing 7 days, regardless of the chosen range -- a fixed
    // "this week" chart, distinct from the range selector.
    Booking.aggregate([
      {
        $match: {
          ...liveStatusFilter,
          startAt: { $gte: new Date(todayEnd.getTime() - 7 * DAY_MS), $lt: todayEnd },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$startAt" } },
          bookingsCount: { $sum: 1 },
          revenueMinor: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ["$status", "completed"] }, { $eq: ["$payment.status", "paid"] }] },
                "$priceMinorAtBooking",
                0,
              ],
            },
          },
        },
      },
      { $sort: { _id: 1 } },
    ]),

    // Recent payments: any booking staff have actually recorded a payment
    // event on, newest first.
    Booking.find({ "payment.recordedAt": { $ne: null } })
      .populate("customer", "name")
      .sort({ "payment.recordedAt": -1 })
      .limit(6),

    // Recent reviews: real and, for now, genuinely empty -- see
    // models/Review.js.
    Review.find({ status: "approved" })
      .populate("barber", "name")
      .populate("customer", "name")
      .sort({ createdAt: -1 })
      .limit(5),
  ]);

  const revenueMinor = paidCompletedInRange.reduce((sum, b) => sum + b.priceMinorAtBooking, 0);
  const newClientsCount = await User.countDocuments({
    role: "customer",
    createdAt: { $gte: rangeStart, $lt: rangeEnd },
  });
  const newActiveCount = await User.countDocuments({
    _id: { $in: activeCustomerIds },
    createdAt: { $gte: rangeStart, $lt: rangeEnd },
  });
  const returningClientsCount = activeCustomerIds.length - newActiveCount;

  const previousRevenueMinor = previousPaidCompleted.reduce((sum, b) => sum + b.priceMinorAtBooking, 0);

  // Ratings are cumulative reputation, not a per-period figure, so this
  // pulls from every approved review regardless of range.
  const ratingsByBarber = await Review.aggregate([
    { $match: { status: "approved" } },
    { $group: { _id: "$barber", avgRating: { $avg: "$rating" }, reviewCount: { $sum: 1 } } },
  ]);
  const ratingMap = new Map(ratingsByBarber.map((r) => [String(r._id), r]));

  // Fill in every day of the trailing week, even ones with zero bookings,
  // so the chart has a real, evenly-spaced x-axis rather than skipping
  // quiet days.
  const dailySeriesByDate = new Map(dailySeriesRaw.map((d) => [d._id, d]));
  const dailySeries = [];
  for (let i = 6; i >= 0; i -= 1) {
    const day = new Date(todayEnd.getTime() - (i + 1) * DAY_MS);
    const key = day.toISOString().slice(0, 10);
    const found = dailySeriesByDate.get(key);
    dailySeries.push({
      date: key,
      bookingsCount: found ? found.bookingsCount : 0,
      revenueMinor: found ? found.revenueMinor : 0,
    });
  }

  const recentPayments = recentPaymentsRaw.map((b) => ({
    bookingId: b._id,
    customerName: b.customer?.name,
    serviceName: b.serviceNameAtBooking,
    amountMinor: b.priceMinorAtBooking,
    currency: b.currencyAtBooking,
    status: b.payment.status,
    method: b.payment.method,
    recordedAt: b.payment.recordedAt,
  }));

  const recentReviews = recentReviewsRaw.map((r) => r.toAdminJSON());

  res.status(200).json({
    range,
    today: {
      bookingsCount: todaysBookingsCount,
      revenueMinor: todaysRevenueMinor,
      currency: dominantCurrency(todaysRevenueBookings),
      cancelledCount: cancelledTodayCount,
      bookingsChangePercent: percentChange(todaysBookingsCount, yesterdaysBookingsCount),
      revenueChangePercent: percentChange(todaysRevenueMinor, yesterdaysRevenueMinor),
    },
    snapshot: {
      totalClients,
      activeBarbers,
      pendingBookingsCount,
      upcomingBookingsCount,
    },
    period: {
      revenueMinor,
      currency: dominantCurrency(paidCompletedInRange),
      bookingsCount: allBookingsInRange,
      liveBookingsCount: activeBookingsInRange,
      newClientsCount,
      returningClientsCount,
      averageBookingValueMinor:
        paidCompletedInRange.length > 0 ? Math.round(revenueMinor / paidCompletedInRange.length) : 0,
      cancellationRate: allBookingsInRange > 0 ? cancelledInRange / allBookingsInRange : 0,
      revenueChangePercent: percentChange(revenueMinor, previousRevenueMinor),
      bookingsChangePercent: percentChange(activeBookingsInRange, previousActiveBookings),
      popularServices: popularServices.map((s) => ({ serviceName: s._id, count: s.count })),
      barberPerformance: barberPerformance.map((b) => ({
        ...b,
        averageRating: ratingMap.get(String(b.barberId))?.avgRating ?? null,
        reviewCount: ratingMap.get(String(b.barberId))?.reviewCount ?? 0,
      })),
    },
    dailySeries,
    recentPayments,
    recentReviews,
  });
};

module.exports = { getOverview };
