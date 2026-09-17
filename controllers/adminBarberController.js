const crypto = require("crypto");

const User = require("../models/User");
const BarberProfile = require("../models/BarberProfile");
const Booking = require("../models/Booking");
const Review = require("../models/Review");
const Service = require("../models/Service");
const { buildWorkingHours } = require("../utils/workingHours");
const { escapeRegex, readPaging } = require("../utils/queryHelpers");
const { recordAudit } = require("../utils/auditLog");
const { notifyBarberSuspended, notifyBarberReactivated } = require("../services/notificationService");

const startOfUtcDay = (date) => {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

/**
 * GET /api/admin/barbers
 * Every barber profile, published or not -- listPublicBarbers in
 * barberController.js only ever shows published ones, which is correct for
 * customers but wrong for staff trying to find someone who has not
 * finished onboarding yet.
 */
const listBarbers = async (req, res) => {
  const { page, limit, skip } = readPaging(req.query);
  const filter = {};

  if (req.query.q) {
    const term = escapeRegex(String(req.query.q).slice(0, 80));
    const pattern = new RegExp(term, "i");
    filter.$or = [{ shopName: pattern }, { city: pattern }];
  }

  const [profiles, total] = await Promise.all([
    BarberProfile.find(filter)
      .populate("user", "name email phone role status")
      .sort({ shopName: 1 })
      .skip(skip)
      .limit(limit),
    BarberProfile.countDocuments(filter),
  ]);

  const barberIds = profiles.map((p) => p.user?._id).filter(Boolean);
  const todayStart = startOfUtcDay(new Date());
  const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
  const weekAgo = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [todaysCounts, weeklyRevenue, ratings] = await Promise.all([
    Booking.aggregate([
      { $match: { barber: { $in: barberIds }, holdsSlot: true, startAt: { $gte: todayStart, $lt: todayEnd } } },
      { $group: { _id: "$barber", count: { $sum: 1 } } },
    ]),
    Booking.aggregate([
      {
        $match: {
          barber: { $in: barberIds },
          status: "completed",
          "payment.status": "paid",
          startAt: { $gte: weekAgo },
        },
      },
      { $group: { _id: "$barber", revenueMinor: { $sum: "$priceMinorAtBooking" } } },
    ]),
    Review.aggregate([
      { $match: { barber: { $in: barberIds }, status: "approved" } },
      { $group: { _id: "$barber", avgRating: { $avg: "$rating" }, reviewCount: { $sum: 1 } } },
    ]),
  ]);

  const todaysMap = new Map(todaysCounts.map((c) => [String(c._id), c.count]));
  const revenueMap = new Map(weeklyRevenue.map((r) => [String(r._id), r.revenueMinor]));
  const ratingMap = new Map(ratings.map((r) => [String(r._id), r]));

  res.status(200).json({
    barbers: profiles.map((profile) => {
      const barberId = String(profile.user?._id);
      const rating = ratingMap.get(barberId);
      return {
        ...profile.toOwnerJSON(),
        email: profile.user?.email,
        phone: profile.user?.phone,
        status: profile.user?.status,
        todaysAppointmentsCount: todaysMap.get(barberId) || 0,
        weeklyRevenueMinor: revenueMap.get(barberId) || 0,
        averageRating: rating?.avgRating ?? null,
        reviewCount: rating?.reviewCount ?? 0,
      };
    }),
    page,
    limit,
    total,
  });
};

/**
 * GET /api/admin/barbers/:id
 * :id is the barber's USER id, same convention as the public
 * GET /api/barbers/:barberId.
 */
const getBarber = async (req, res) => {
  const barberId = req.params.id;

  const [user, profile] = await Promise.all([
    User.findOne({ _id: barberId, role: "barber" }),
    BarberProfile.findOne({ user: barberId }),
  ]);

  if (!user) {
    return res.status(404).json({ errors: [{ message: "Barber not found" }] });
  }

  const todayStart = startOfUtcDay(new Date());
  const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
  const weekAgo = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [todaysAppointmentsCount, weekBookings, ratingRows, upcomingBookingsCount] = await Promise.all([
    Booking.countDocuments({
      barber: barberId,
      holdsSlot: true,
      startAt: { $gte: todayStart, $lt: todayEnd },
    }),
    Booking.find({
      barber: barberId,
      status: "completed",
      "payment.status": "paid",
      startAt: { $gte: weekAgo },
    }).select("priceMinorAtBooking"),
    Review.aggregate([
      { $match: { barber: user._id, status: "approved" } },
      { $group: { _id: "$barber", avgRating: { $avg: "$rating" }, reviewCount: { $sum: 1 } } },
    ]),
    // Used by the "Delete barber" confirmation to warn about appointments
    // that would be left on the books once the account is gone.
    Booking.countDocuments({ barber: barberId, holdsSlot: true, startAt: { $gte: new Date() } }),
  ]);

  const weeklyRevenueMinor = weekBookings.reduce(
    (sum, b) => sum + b.priceMinorAtBooking,
    0
  );

  res.status(200).json({
    barber: {
      id: user._id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      status: user.status,
      rejectionReason: user.rejectionReason,
      profile: profile ? profile.toOwnerJSON() : null,
    },
    todaysAppointmentsCount,
    weeklyRevenueMinor,
    averageRating: ratingRows[0]?.avgRating ?? null,
    reviewCount: ratingRows[0]?.reviewCount ?? 0,
    upcomingBookingsCount,
  });
};

/**
 * POST /api/admin/barbers
 * Creates the barber's account and shop profile together. There is no
 * public barber self-registration path that also creates a profile in one
 * step -- a new barber normally registers, then fills in their own profile
 * via PUT /api/barbers/me. This is the staff-invited equivalent.
 *
 * The password is randomly generated and returned ONCE, in this response
 * only. There is no email-sending set up in this codebase to deliver it any
 * other way, so it is staff's job to pass it on to the barber, who should
 * change it once they can (there is no change-password endpoint yet either
 * -- a real gap, out of scope for this pass).
 */
const createBarber = async (req, res) => {
  const { name, email, phone, shopName, city, timeZone, bio, addressLine, publicPhone } =
    req.body;

  const normalizedEmail = String(email).trim().toLowerCase();
  const existing = await User.findOne({ email: normalizedEmail });
  if (existing) {
    return res.status(409).json({ errors: [{ message: "That email is already registered", path: "email" }] });
  }

  const temporaryPassword = crypto.randomBytes(9).toString("base64url");

  const user = await User.create({
    name,
    email: normalizedEmail,
    phone,
    password: temporaryPassword,
    role: "barber",
    // An admin creating this account directly IS the review -- unlike
    // self-registration (authController.register), it skips the
    // pending_approval queue and starts active right away.
    status: "active",
    acceptedPolicies: true,
    acceptedPoliciesAt: new Date(),
  });

  const profile = await BarberProfile.create({
    user: user._id,
    shopName,
    city,
    timeZone,
    bio: bio || "",
    addressLine: addressLine || "",
    publicPhone: publicPhone || "",
  });

  // NOTE: temporaryPassword is deliberately NOT in the summary. It is a
  // live credential; an audit log is the last place it should be written.
  await recordAudit(req, {
    action: "barber.create",
    resourceType: "barber",
    resourceId: user._id,
    summary: `Created barber ${user.name} (${user.email}) for shop ${profile.shopName}.`,
  });

  res.status(201).json({
    message: "Barber created. Share this temporary password with them -- it will not be shown again.",
    temporaryPassword,
    barber: { id: user._id, name: user.name, email: user.email, profile: profile.toOwnerJSON() },
  });
};

/**
 * PATCH /api/admin/barbers/:id
 * Edits the shop profile: everything the barber's own PUT /api/barbers/me
 * can change, plus timeOff, plus staff can flip isPublished/
 * isAcceptingBookings on someone else's behalf ("deactivate" a barber is
 * just setting both to false -- see the note in the routes file for why
 * there is no separate deactivate endpoint).
 */
const updateBarber = async (req, res) => {
  const profile = await BarberProfile.findOne({ user: req.params.id });
  if (!profile) {
    return res.status(404).json({ errors: [{ message: "Barber profile not found" }] });
  }

  const {
    shopName, bio, city, addressLine, publicPhone, timeZone,
    workingHours, isPublished, isAcceptingBookings, timeOff,
    name, phone,
  } = req.body;

  if (shopName !== undefined) profile.shopName = shopName;
  if (bio !== undefined) profile.bio = bio;
  if (city !== undefined) profile.city = city;
  if (addressLine !== undefined) profile.addressLine = addressLine;
  if (publicPhone !== undefined) profile.publicPhone = publicPhone;
  if (timeZone !== undefined) profile.timeZone = timeZone;
  if (Array.isArray(workingHours)) profile.workingHours = buildWorkingHours(workingHours);
  if (typeof isPublished === "boolean") profile.isPublished = isPublished;
  if (typeof isAcceptingBookings === "boolean") profile.isAcceptingBookings = isAcceptingBookings;
  if (Array.isArray(timeOff)) {
    profile.timeOff = timeOff.map((entry) => ({
      startDate: entry.startDate,
      endDate: entry.endDate,
      reason: entry.reason || "",
    }));
  }

  await profile.save();

  if (name !== undefined || phone !== undefined) {
    const user = await User.findOne({ _id: req.params.id, role: "barber" });
    if (user) {
      if (name !== undefined) user.name = name;
      if (phone !== undefined) user.phone = phone;
      await user.save();
    }
  }

  res.status(200).json({ message: "Barber updated.", profile: profile.toOwnerJSON() });
};

/**
 * DELETE /api/admin/barbers/:id
 * Permanently removes the barber's account and shop profile. Historical
 * bookings are never touched -- same reasoning as
 * adminClientController.deleteClient, applied to the barber side.
 *
 * Their services are handled with the exact same safe rule
 * adminServiceController.deleteAnyService already uses for one service at a
 * time: deactivate (not delete) any service with upcoming bookings against
 * it, since those bookings still need a real service to point to; hard-
 * delete the rest, since Booking already snapshots service name/price/
 * duration independently and does not need the Service document to survive.
 * Either way nothing can book this barber again once this finishes: the
 * BarberProfile (the thing that makes them appear in availability at all)
 * is deleted along with the account.
 */
const deleteBarber = async (req, res) => {
  const user = await User.findOne({ _id: req.params.id, role: "barber" });
  if (!user) {
    return res.status(404).json({ errors: [{ message: "Barber not found" }] });
  }

  // One-time name snapshot onto every booking this barber ever had, same
  // reasoning as deleteClient -- see Booking.barberNameAtBooking.
  await Booking.updateMany({ barber: user._id }, { $set: { barberNameAtBooking: user.name } });

  const services = await Service.find({ barber: user._id });
  const now = new Date();
  for (const service of services) {
    const upcomingCount = await Booking.countDocuments({
      service: service._id,
      holdsSlot: true,
      startAt: { $gte: now },
    });

    if (upcomingCount > 0) {
      service.isActive = false;
      await service.save();
    } else {
      await service.deleteOne();
    }
  }

  await BarberProfile.deleteOne({ user: user._id });
  await user.deleteOne();

  await recordAudit(req, {
    action: "barber.delete",
    resourceType: "barber",
    resourceId: user._id,
    summary: `Permanently deleted barber ${user.name} (${user.email}). Booking history preserved.`,
  });

  res.status(200).json({ message: "Barber deleted." });
};

/**
 * PATCH /api/admin/barbers/:id/suspend
 * ADMIN FULL CONTROL: takes an already-active barber offline without
 * deleting anything. Unlike deleteBarber, the account and profile survive
 * intact -- this is reversible via reactivateBarber below. Unpublishing
 * stops them appearing bookable immediately; requireActiveBarber (see
 * middleware/auth.js) is what blocks their own dashboard/login-gated
 * requests from this point on.
 */
const suspendBarber = async (req, res) => {
  const user = await User.findOne({ _id: req.params.id, role: "barber" });
  if (!user) {
    return res.status(404).json({ errors: [{ message: "Barber not found" }] });
  }

  user.status = "suspended";
  await user.save();

  const profile = await BarberProfile.findOne({ user: user._id });
  if (profile) {
    profile.isPublished = false;
    await profile.save();
  }

  await recordAudit(req, {
    action: "barber.suspend",
    resourceType: "barber",
    resourceId: user._id,
    summary: `Suspended barber ${user.name} (${user.email}). Profile unpublished.`,
  });

  try {
    await notifyBarberSuspended(user);
  } catch (error) {
    console.error("Barber-suspended notification failed:", error.message);
  }

  res.status(200).json({
    message: "Barber suspended.",
    barberId: user._id,
    status: user.status,
    isPublished: profile ? profile.isPublished : undefined,
  });
};

/**
 * PATCH /api/admin/barbers/:id/reactivate
 * Reverses a suspension, or lets an admin directly reinstate a rejected
 * application without the barber having to resubmit it themselves (see
 * barberController.resubmitApplication for the barber-initiated path).
 * Republishes the profile, same as approveApplication -- reactivate should
 * leave the barber exactly where approve would.
 */
const reactivateBarber = async (req, res) => {
  const user = await User.findOne({ _id: req.params.id, role: "barber" });
  if (!user) {
    return res.status(404).json({ errors: [{ message: "Barber not found" }] });
  }

  if (user.status !== "suspended" && user.status !== "rejected") {
    return res.status(409).json({
      errors: [{ message: `A barber who is "${user.status}" cannot be reactivated.` }],
    });
  }

  user.status = "active";
  user.rejectionReason = "";
  await user.save();

  const profile = await BarberProfile.findOne({ user: user._id });
  if (profile) {
    profile.isPublished = true;
    await profile.save();
  }

  await recordAudit(req, {
    action: "barber.reactivate",
    resourceType: "barber",
    resourceId: user._id,
    summary: `Reactivated barber ${user.name} (${user.email}). Profile republished.`,
  });

  try {
    await notifyBarberReactivated(user);
  } catch (error) {
    console.error("Barber-reactivated notification failed:", error.message);
  }

  res.status(200).json({
    message: "Barber reactivated.",
    barberId: user._id,
    status: user.status,
    isPublished: profile ? profile.isPublished : undefined,
  });
};

module.exports = {
  listBarbers, getBarber, createBarber, updateBarber, deleteBarber,
  suspendBarber, reactivateBarber,
};
