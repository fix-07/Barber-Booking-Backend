const mongoose = require("mongoose");

/**
 * Appointment statuses.
 *
 * We keep "cancelled by customer" and "cancelled by barber" as separate
 * statuses rather than one "cancelled". That distinction is not decoration:
 * who cancelled usually decides what the refund rules are, so the data has
 * to record it. (The actual refund rules are yours to set - see Phase 5.)
 */
const BOOKING_STATUSES = [
  "pending",               // customer requested, barber has not confirmed
  "confirmed",             // barber accepted
  "completed",             // appointment happened
  "cancelled_by_customer",
  "cancelled_by_barber",
  "cancelled_by_admin",
  "no_show",               // customer did not turn up
];

/**
 * Statuses that still occupy the barber's time slot.
 * A cancelled appointment frees the slot; everything else holds it.
 */
const SLOT_HOLDING_STATUSES = [
  "pending",
  "confirmed",
  "completed",
  "no_show",
];

const bookingSchema = new mongoose.Schema(
  {
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    barber: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    service: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Service",
      required: true,
    },

    startAt: {
      type: Date,
      required: [true, "Appointment start time is required"],
    },

    endAt: {
      type: Date,
      required: true,
    },

    status: {
      type: String,
      enum: {
        values: BOOKING_STATUSES,
        message: "Unknown booking status.",
      },
      default: "pending",
    },

    /**
     * SNAPSHOT FIELDS.
     *
     * WHY WE COPY THE SERVICE DETAILS INSTEAD OF ONLY LINKING TO IT:
     * If a barber raises their price from 12.50 to 15.00 next month, every
     * past booking must still show what the customer actually agreed to
     * pay. The same applies if the barber renames or deactivates the
     * service. Without these copies your booking history would silently
     * rewrite itself, which is confusing and a consumer-protection problem.
     */
    serviceNameAtBooking: {
      type: String,
      required: true,
      maxlength: 80,
    },
    durationMinutesAtBooking: {
      type: Number,
      required: true,
      min: 5,
    },
    priceMinorAtBooking: {
      type: Number,
      required: true,
      min: 0,
    },
    currencyAtBooking: {
      type: String,
      required: true,
      match: /^[A-Z]{3}$/,
    },

    // Optional note from the customer, for example "running 5 minutes late".
    // Optional on purpose: we do not require extra personal details to book.
    customerNote: {
      type: String,
      trim: true,
      maxlength: [300, "Note cannot be longer than 300 characters"],
      default: "",
    },

    // Internal note staff can add (e.g. "asked for a later reminder call").
    // Separate from customerNote: this one is never shown to the customer.
    staffNote: {
      type: String,
      trim: true,
      maxlength: [500, "Note cannot be longer than 500 characters"],
      default: "",
    },

    /**
     * Name snapshots, same idea as serviceNameAtBooking above but for WHO
     * the booking was with -- filled in only once, at the moment an admin
     * permanently deletes a client or barber account (see
     * adminClientController.deleteClient / adminBarberController.deleteBarber).
     *
     * WHY NOT SET THESE ON EVERY BOOKING, THE WAY THE SERVICE FIELDS ARE:
     * customer/barber are still live accounts for the overwhelming majority
     * of bookings, and toJSONFor() already reads their real, current name
     * via .populate(). Writing a redundant copy on every single booking
     * would cost a lookup on every create for a value almost never needed.
     * Backfilling it once, right before the account is deleted, gets the
     * same end result (history keeps reading correctly forever) for a cost
     * that is paid only when an account actually disappears.
     */
    customerNameAtBooking: { type: String, default: null },
    barberNameAtBooking: { type: String, default: null },

    // Cancellation record.
    cancelledAt: { type: Date, default: null },
    cancelledBy: {
      type: String,
      enum: ["customer", "barber", "admin", null],
      default: null,
    },
    cancellationReason: {
      type: String,
      trim: true,
      maxlength: [300, "Reason cannot be longer than 300 characters"],
      default: "",
    },

    /**
     * Manual payment record.
     *
     * WHY THIS EXISTS, AND WHY IT IS NOT A REAL PAYMENT INTEGRATION:
     * This app has no payment processor -- see config/business.js's
     * appFacts.takesOnlinePayments, which stays false. Customers pay the
     * barber in person, the way most barbershops actually work. This just
     * lets staff record what already happened in the shop (cash or card in
     * person) so the books add up; it never touches a card number.
     */
    payment: {
      status: {
        type: String,
        enum: ["unpaid", "paid", "refunded", "failed"],
        default: "unpaid",
      },
      method: {
        type: String,
        enum: ["cash", "card", "other", null],
        default: null,
      },
      recordedAt: { type: Date, default: null },
      recordedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },
    },

    /**
     * Derived flag: true while this booking still occupies the slot.
     *
     * WHY A SEPARATE BOOLEAN INSTEAD OF CHECKING status DIRECTLY:
     * It lets us put a UNIQUE DATABASE INDEX on (barber, startAt) that
     * applies only to live bookings. An index that ignored status would
     * also block re-booking a slot whose earlier booking was cancelled.
     * Using one true/false field keeps the index condition simple, which
     * also means it works on every MongoDB version.
     */
    holdsSlot: {
      type: Boolean,
      default: true,
      required: true,
    },
  },
  { timestamps: true }
);

/**
 * THE DOUBLE-BOOKING GUARANTEE.
 *
 * The booking controller already queries for overlapping appointments
 * before saving. But query-then-save has a gap: two requests can both run
 * the query, both see "free", and both save. That is a race condition.
 *
 * This unique index closes the common case at the DATABASE level, which no
 * amount of application code can race against. If two customers click the
 * same 10:00 slot at the same moment, one save succeeds and the other is
 * rejected with duplicate-key error 11000.
 *
 * HONEST LIMITATION - please read:
 * This index guarantees no two live bookings share the exact same start
 * time for one barber. It does NOT catch a partial overlap under a race,
 * for example 10:00-10:45 against 10:30-11:00. The overlap query in the
 * controller does catch those, but a simultaneous pair could in theory
 * slip past it. Closing that completely needs a MongoDB transaction,
 * which requires a replica set. MongoDB Atlas is a replica set, so you
 * CAN add that later. I have not, because it adds real complexity and the
 * remaining window is narrow: customers click slots that a UI offered
 * them, and those share start times.
 */
bookingSchema.index(
  { barber: 1, startAt: 1 },
  {
    unique: true,
    partialFilterExpression: { holdsSlot: true },
    name: "one_live_booking_per_barber_per_start_time",
  }
);

// Fast lookups for the "my bookings" and "my appointments" screens.
bookingSchema.index({ customer: 1, startAt: -1 });
bookingSchema.index({ barber: 1, startAt: -1 });

// adminAnalyticsController.getOverview runs ~10 queries/aggregations that
// all filter on {status (often $in), startAt range} with no barber/customer
// in the filter -- measured at 546-621ms with a 300-booking seed dataset
// (mostly Atlas network latency at this size, but the pattern only gets
// more expensive as the collection grows without this). This is the
// compound shape every one of those queries actually needs.
bookingSchema.index({ status: 1, startAt: 1 });

/**
 * Keeps holdsSlot in step with status automatically, so no controller can
 * forget to update it.
 *
 * MONGOOSE 9 NOTE: document hooks take NO "next" argument in Mongoose 9,
 * async or not. See the same note in models/BarberProfile.js.
 */
bookingSchema.pre("validate", function () {
  this.holdsSlot = SLOT_HOLDING_STATUSES.includes(this.status);

  if (this.startAt && this.endAt && this.endAt <= this.startAt) {
    this.invalidate("endAt", "Appointment end time must be after its start time.");
  }
});

/** Is this appointment cancelled, by either side? */
bookingSchema.methods.isCancelled = function () {
  return (
    this.status === "cancelled_by_customer" ||
    this.status === "cancelled_by_barber" ||
    this.status === "cancelled_by_admin"
  );
};

/**
 * Shape sent to the frontend.
 *
 * IMPORTANT: this returns ids and display names only. It never includes the
 * other party's email. A customer seeing their booking gets the barber's
 * display name, not their account data.
 *
 * The one exception is deliberate: a barber sees the customer's name and
 * phone number for their own appointments, because contacting a customer
 * about their appointment is the entire reason the phone field exists.
 */
bookingSchema.methods.toJSONFor = function (viewerRole) {
  const populatedCustomer =
    this.customer && this.customer.name ? this.customer : null;
  const populatedBarber =
    this.barber && this.barber.name ? this.barber : null;

  const base = {
    id: this._id,
    startAt: this.startAt,
    endAt: this.endAt,
    status: this.status,
    serviceName: this.serviceNameAtBooking,
    durationMinutes: this.durationMinutesAtBooking,
    priceMinor: this.priceMinorAtBooking,
    currency: this.currencyAtBooking,
    customerNote: this.customerNote,
    cancelledAt: this.cancelledAt,
    cancelledBy: this.cancelledBy,
    cancellationReason: this.cancellationReason,
    createdAt: this.createdAt,
    barberId: populatedBarber ? populatedBarber._id : this.barber,
    customerId: populatedCustomer ? populatedCustomer._id : this.customer,
  };

  // Falls back to the name snapshot (see customerNameAtBooking /
  // barberNameAtBooking above) when the account no longer exists -- an
  // admin permanently deleted it, so .populate() cannot find it any more.
  // "Deleted client"/"Deleted barber" is the last-resort fallback for a
  // booking old enough to predate that snapshot ever being written.
  const customerDisplayName = populatedCustomer
    ? populatedCustomer.name
    : this.customerNameAtBooking || "Deleted client";
  const barberDisplayName = populatedBarber
    ? populatedBarber.name
    : this.barberNameAtBooking || "Deleted barber";

  // A customer needs to know WHICH barber. Name only.
  if (viewerRole === "customer") {
    base.barberName = barberDisplayName;
  }

  // A barber needs to know WHO is coming, and how to reach them. Phone is
  // simply gone once the account is deleted -- unlike the name, it is not
  // snapshotted, because it is exactly the kind of personal data deleting
  // the account is meant to remove.
  if (viewerRole === "barber") {
    base.customerName = customerDisplayName;
    base.customerPhone = populatedCustomer ? populatedCustomer.phone : undefined;
  }

  // Staff running the shop need both sides, plus the internal fields
  // neither a customer nor the other barber's appointments ever see.
  if (viewerRole === "admin") {
    base.customerName = customerDisplayName;
    base.customerPhone = populatedCustomer ? populatedCustomer.phone : undefined;
    base.customerEmail = populatedCustomer ? populatedCustomer.email : undefined;
    base.barberName = barberDisplayName;
    base.staffNote = this.staffNote;
    base.payment = this.payment;
  }

  return base;
};

const Booking = mongoose.model("Booking", bookingSchema);

Booking.BOOKING_STATUSES = BOOKING_STATUSES;
Booking.SLOT_HOLDING_STATUSES = SLOT_HOLDING_STATUSES;

module.exports = Booking;
