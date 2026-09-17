const mongoose = require("mongoose");

/**
 * A customer's review of a barber.
 *
 * A customer submits a review from their completed booking on MyBookingsPage
 * (POST /api/reviews). Admin moderation (approve/hide/respond/delete) is at
 * /api/admin/reviews. Approved reviews appear on the barber's public profile.
 */
const reviewSchema = new mongoose.Schema(
  {
    barber: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Optional: which appointment this review is about, if any.
    booking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      default: null,
    },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
    },
    comment: {
      type: String,
      trim: true,
      maxlength: [1000, "A review cannot be longer than 1000 characters"],
      default: "",
    },
    // pending: awaiting moderation. approved: shown publicly (once there is
    // somewhere to show it). hidden: moderated off, kept for the record
    // rather than deleted, unless staff explicitly delete it.
    status: {
      type: String,
      enum: ["pending", "approved", "hidden"],
      default: "pending",
    },
    adminResponse: {
      type: String,
      trim: true,
      maxlength: [1000, "A response cannot be longer than 1000 characters"],
      default: "",
    },
  },
  { timestamps: true }
);

reviewSchema.index({ status: 1, createdAt: -1 });

reviewSchema.methods.toAdminJSON = function () {
  const populatedBarber = this.barber && this.barber.name ? this.barber : null;
  const populatedCustomer = this.customer && this.customer.name ? this.customer : null;

  return {
    id: this._id,
    barberId: populatedBarber ? populatedBarber._id : this.barber,
    barberName: populatedBarber ? populatedBarber.name : undefined,
    customerId: populatedCustomer ? populatedCustomer._id : this.customer,
    customerName: populatedCustomer ? populatedCustomer.name : undefined,
    bookingId: this.booking,
    rating: this.rating,
    comment: this.comment,
    status: this.status,
    adminResponse: this.adminResponse,
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.model("Review", reviewSchema);
