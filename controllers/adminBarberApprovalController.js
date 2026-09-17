const User = require("../models/User");
const BarberProfile = require("../models/BarberProfile");
const { readPaging } = require("../utils/queryHelpers");
const { recordAudit } = require("../utils/auditLog");
const { notifyBarberApproved, notifyBarberRejected } = require("../services/notificationService");

/**
 * Admin -> Barber Approvals: review new barber applications and decide
 * APPROVE / REJECT. Suspending or reactivating an already-active barber
 * lives in adminBarberController.js instead (suspendBarber/reactivateBarber)
 * -- this file is specifically the new-application review queue described
 * in the approval spec (Pending / Approved / Rejected sections).
 *
 * "Approved" here means "went through this queue and is active", so the
 * Approved/Rejected tabs are a history of decisions, not just the live
 * roster -- see listApplications' status filter.
 */

const combine = (user, profile) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  phone: user.phone,
  status: user.status,
  rejectionReason: user.rejectionReason,
  appliedAt: user.createdAt,
  photoUrl: profile?.photoUrl || "",
  shopName: profile?.shopName || "",
  city: profile?.city || "",
  bio: profile?.bio || "",
  experience: profile?.experience || "",
  specialties: profile?.specialties || [],
  requestedServices: profile?.requestedServices || [],
  timeZone: profile?.timeZone || "",
  workingHours: profile?.workingHours || [],
});

/**
 * GET /api/admin/barber-approvals?status=pending_approval|active|rejected|suspended
 * Defaults to pending_approval -- the queue an admin opens this page to
 * clear.
 */
const listApplications = async (req, res) => {
  const { page, limit, skip } = readPaging(req.query);
  const status = ["pending_approval", "active", "rejected", "suspended"].includes(req.query.status)
    ? req.query.status
    : "pending_approval";

  const filter = { role: "barber", status };

  const [users, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    User.countDocuments(filter),
  ]);

  const profiles = await BarberProfile.find({ user: { $in: users.map((u) => u._id) } });
  const profileByUser = new Map(profiles.map((p) => [String(p.user), p]));

  res.status(200).json({
    applications: users.map((user) => combine(user, profileByUser.get(String(user._id)))),
    page,
    limit,
    total,
  });
};

const findApplicantOr404 = async (id, res) => {
  const user = await User.findOne({ _id: id, role: "barber" });
  if (!user) {
    res.status(404).json({ errors: [{ message: "Barber application not found" }] });
    return null;
  }
  return user;
};

/**
 * PATCH /api/admin/barber-approvals/:id/approve
 * -> status becomes ACTIVE, account can log in and use the dashboard
 * (requireActiveBarber in middleware/auth.js), and the profile is published
 * so the barber is immediately bookable -- matching the spec's "Barber
 * becomes available for bookings" outcome with no separate manual publish
 * step required.
 */
const approveApplication = async (req, res) => {
  const user = await findApplicantOr404(req.params.id, res);
  if (!user) return;

  user.status = "active";
  user.rejectionReason = "";
  await user.save();

  const profile = await BarberProfile.findOne({ user: user._id });
  if (profile) {
    profile.isPublished = true;
    await profile.save();
  }

  await recordAudit(req, {
    action: "barber.approve",
    resourceType: "barber",
    resourceId: user._id,
    summary: `Approved barber application for ${user.name} (${user.email}). Account is now active and bookable.`,
  });

  try {
    await notifyBarberApproved(user);
  } catch (error) {
    console.error("Barber-approved notification failed:", error.message);
  }

  res.status(200).json({
    message: "Barber approved.",
    application: combine(user, profile),
  });
};

/**
 * PATCH /api/admin/barber-approvals/:id/reject
 * body: { reason }
 * -> status becomes REJECTED. The barber sees the reason on their status
 * page (client/src/pages/BarberStatusPage.js) and can edit + resubmit via
 * PATCH /api/barbers/me/resubmit.
 */
const rejectApplication = async (req, res) => {
  const user = await findApplicantOr404(req.params.id, res);
  if (!user) return;

  user.status = "rejected";
  user.rejectionReason = ((req.body && req.body.reason) || "").slice(0, 500);
  await user.save();

  const profile = await BarberProfile.findOne({ user: user._id });
  if (profile) {
    profile.isPublished = false;
    await profile.save();
  }

  await recordAudit(req, {
    action: "barber.reject",
    resourceType: "barber",
    resourceId: user._id,
    summary: user.rejectionReason
      ? `Rejected barber application for ${user.name} (${user.email}). Reason given: ${user.rejectionReason}`
      : `Rejected barber application for ${user.name} (${user.email}). No reason given.`,
  });

  try {
    await notifyBarberRejected(user, user.rejectionReason);
  } catch (error) {
    console.error("Barber-rejected notification failed:", error.message);
  }

  res.status(200).json({
    message: "Barber application rejected.",
    application: combine(user, profile),
  });
};

/**
 * DELETE /api/admin/barber-approvals/:id
 * A REAL, permanent delete of the application (User + BarberProfile) --
 * safe to do outright here, unlike adminBarberController.deleteBarber,
 * because a pending or rejected applicant was NEVER active: requireActiveBarber
 * (middleware/auth.js) blocks every barber-dashboard route until status is
 * "active", so they could never have created a service or received a
 * booking. There is no historical record this could corrupt.
 *
 * Refused for "active" or "suspended" barbers -- both of those CAN have
 * real booking history, which is exactly what deleteBarber's name-snapshot
 * step exists to preserve (see Booking.barberNameAtBooking). Delete those
 * from Admin -> Barbers instead.
 */
const deleteApplication = async (req, res) => {
  const user = await findApplicantOr404(req.params.id, res);
  if (!user) return;

  if (user.status !== "pending_approval" && user.status !== "rejected") {
    return res.status(409).json({
      errors: [{
        message: `A barber who is "${user.status}" may have real booking history and must be deleted from Admin -> Barbers instead, which preserves it.`,
      }],
    });
  }

  const previousStatus = user.status;
  await BarberProfile.deleteOne({ user: user._id });
  await user.deleteOne();

  await recordAudit(req, {
    action: "barber.application.delete",
    resourceType: "barber",
    resourceId: user._id,
    summary: `Deleted ${previousStatus} barber application for ${user.name} (${user.email}).`,
  });

  res.status(200).json({ message: "Application deleted." });
};

module.exports = { listApplications, approveApplication, rejectApplication, deleteApplication };
