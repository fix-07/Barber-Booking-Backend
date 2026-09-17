const Review = require("../models/Review");
const Booking = require("../models/Booking");

/**
 * POST /api/reviews
 * Customer submits a review for a completed booking they own.
 */
const createReview = async (req, res) => {
  const { bookingId, rating, comment } = req.body;

  const booking = await Booking.findById(bookingId);
  if (!booking) {
    return res.status(404).json({ message: "Booking not found.", errors: {} });
  }

  // Ownership check: req.user comes from the verified JWT, not the request body.
  if (String(booking.customer) !== String(req.user._id)) {
    return res
      .status(403)
      .json({ message: "You can only review your own bookings.", errors: {} });
  }

  if (booking.status !== "completed") {
    return res
      .status(400)
      .json({ message: "You can only review a completed appointment.", errors: {} });
  }

  const existing = await Review.findOne({ booking: bookingId });
  if (existing) {
    return res
      .status(409)
      .json({ message: "You have already reviewed this booking.", errors: {} });
  }

  const review = await Review.create({
    barber: booking.barber,
    customer: req.user._id,
    booking: bookingId,
    rating,
    comment: comment || "",
    status: "pending",
  });

  return res.status(201).json({
    message: "Review submitted. It will appear publicly once approved.",
    review: {
      id: review._id,
      rating: review.rating,
      comment: review.comment,
      status: review.status,
      createdAt: review.createdAt,
    },
  });
};

/**
 * GET /api/reviews/mine
 * Returns the logged-in customer's own reviews, newest first.
 */
const getMyReviews = async (req, res) => {
  const reviews = await Review.find({ customer: req.user._id })
    .populate("barber", "name")
    .sort({ createdAt: -1 });

  return res.status(200).json({
    reviews: reviews.map((r) => ({
      id: r._id,
      bookingId: r.booking,
      barberId: r.barber?._id,
      barberName: r.barber?.name,
      rating: r.rating,
      comment: r.comment,
      status: r.status,
      adminResponse: r.adminResponse,
      createdAt: r.createdAt,
    })),
  });
};

module.exports = { createReview, getMyReviews };
