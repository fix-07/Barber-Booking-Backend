const Review = require("../models/Review");
const { readPaging } = require("../utils/queryHelpers");
const { recordAudit } = require("../utils/auditLog");

/**
 * GET /api/admin/reviews
 * Starts genuinely empty until a customer-facing submission path exists --
 * see the note at the top of models/Review.js.
 */
const listReviews = async (req, res) => {
  const { page, limit, skip } = readPaging(req.query);
  const filter = {};

  if (["pending", "approved", "hidden"].includes(req.query.status)) {
    filter.status = req.query.status;
  }
  if (req.query.barberId) filter.barber = req.query.barberId;

  const [reviews, total] = await Promise.all([
    Review.find(filter)
      .populate("barber", "name")
      .populate("customer", "name")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Review.countDocuments(filter),
  ]);

  res.status(200).json({
    reviews: reviews.map((review) => review.toAdminJSON()),
    page,
    limit,
    total,
  });
};

const findReviewOr404 = async (id, res) => {
  const review = await Review.findById(id)
    .populate("barber", "name")
    .populate("customer", "name");
  if (!review) {
    res.status(404).json({ errors: [{ message: "Review not found" }] });
    return null;
  }
  return review;
};

/** PATCH /api/admin/reviews/:id/approve */
const approveReview = async (req, res) => {
  const review = await findReviewOr404(req.params.id, res);
  if (!review) return;
  review.status = "approved";
  await review.save();
  res.status(200).json({ message: "Review approved.", review: review.toAdminJSON() });
};

/** PATCH /api/admin/reviews/:id/hide */
const hideReview = async (req, res) => {
  const review = await findReviewOr404(req.params.id, res);
  if (!review) return;
  review.status = "hidden";
  await review.save();
  res.status(200).json({ message: "Review hidden.", review: review.toAdminJSON() });
};

/** PATCH /api/admin/reviews/:id/respond */
const respondToReview = async (req, res) => {
  const review = await findReviewOr404(req.params.id, res);
  if (!review) return;
  review.adminResponse = req.body.adminResponse || "";
  await review.save();
  res.status(200).json({ message: "Response saved.", review: review.toAdminJSON() });
};

/** DELETE /api/admin/reviews/:id */
const deleteReview = async (req, res) => {
  const review = await Review.findById(req.params.id);
  if (!review) {
    return res.status(404).json({ errors: [{ message: "Review not found" }] });
  }
  await review.deleteOne();

  await recordAudit(req, {
    action: "review.delete",
    resourceType: "review",
    resourceId: review._id,
    summary: `Permanently deleted a ${review.rating}-star review.`,
  });

  res.status(200).json({ message: "Review deleted." });
};

module.exports = { listReviews, approveReview, hideReview, respondToReview, deleteReview };
