const BarberProfile = require("../models/BarberProfile");
const Service = require("../models/Service");
const User = require("../models/User");
const Review = require("../models/Review");
const { escapeRegex, readPaging: readPagingBase } = require("../utils/queryHelpers");
const { buildWorkingHours } = require("../utils/workingHours");

// This endpoint's public page size predates queryHelpers.js and stays at
// 12/50 rather than the shared default, so existing frontend paging is
// unaffected.
const readPaging = (query) => readPagingBase(query, { defaultLimit: 12, maxLimit: 50 });

/**
 * GET /api/barbers
 * PUBLIC. Lists published barber profiles.
 *
 * Returns only what a visitor needs to choose a barber. No emails, no
 * account phone numbers, no booking data. See BarberProfile.toPublicJSON.
 */
const listPublicBarbers = async (req, res) => {
  const { page, limit, skip } = readPaging(req.query);

  // Only published profiles are visible to the public. A barber who has
  // not published yet is invisible, which is the safe default.
  const filter = { isPublished: true };

  if (req.query.city) {
    const city = String(req.query.city).slice(0, 80);
    filter.city = new RegExp("^" + escapeRegex(city), "i");
  }

  if (req.query.q) {
    const term = String(req.query.q).slice(0, 80);
    filter.shopName = new RegExp(escapeRegex(term), "i");
  }

  const [profiles, total] = await Promise.all([
    BarberProfile.find(filter)
      .populate("user", "name role status") // name for display, role+status to verify
      .sort({ shopName: 1 })
      .skip(skip)
      .limit(limit),
    BarberProfile.countDocuments(filter),
  ]);

  // Defensive filter: if an account was demoted from barber, or is not an
  // approved & active barber (pending/rejected/suspended), its profile
  // should not keep appearing in the public list -- see requireActiveBarber
  // in middleware/auth.js for the matching dashboard-side gate.
  const visible = profiles.filter(
    (profile) => profile.user && profile.user.role === "barber" && profile.user.status === "active"
  );

  res.status(200).json({
    barbers: visible.map((profile) => profile.toPublicJSON()),
    page,
    limit,
    total,
  });
};

/**
 * GET /api/barbers/:barberId
 * PUBLIC. One barber's profile plus their active services.
 *
 * :barberId is the barber's USER id, which is also what the booking
 * endpoint expects, so the frontend only has to carry one id around.
 */
const getPublicBarber = async (req, res) => {
  const profile = await BarberProfile.findOne({
    user: req.params.barberId,
    isPublished: true,
  }).populate("user", "name role status");

  // We return the same 404 whether the profile does not exist, is simply
  // unpublished, or belongs to a barber who is not currently active (still
  // pending approval, rejected, or suspended). Saying "exists but hidden"
  // would leak the existence of profiles their owners -- or VEYRON admin --
  // have chosen not to show.
  if (!profile || !profile.user || profile.user.role !== "barber" || profile.user.status !== "active") {
    return res.status(404).json({errors : [{message: "Barber not found"}]});
  }

  const [services, ratingAgg, recentReviews] = await Promise.all([
    Service.find({ barber: profile.user._id, isActive: true }).sort({ name: 1 }),
    Review.aggregate([
      { $match: { barber: profile.user._id, status: "approved" } },
      { $group: { _id: null, avg: { $avg: "$rating" }, count: { $sum: 1 } } },
    ]),
    Review.find({ barber: profile.user._id, status: "approved" })
      .populate("customer", "name")
      .sort({ createdAt: -1 })
      .limit(10),
  ]);

  const ratingData = ratingAgg[0] || null;

  res.status(200).json({
    barber: profile.toPublicJSON(),
    services: services.map((service) => service.toPublicJSON()),
    averageRating: ratingData ? Math.round(ratingData.avg * 10) / 10 : null,
    reviewCount: ratingData ? ratingData.count : 0,
    reviews: recentReviews.map((r) => ({
      id: r._id,
      rating: r.rating,
      comment: r.comment,
      customerName: r.customer?.name || "Customer",
      adminResponse: r.adminResponse || "",
      createdAt: r.createdAt,
    })),
  });
};

/**
 * GET /api/barbers/me/status
 * Barber only, and deliberately WITHOUT requireActiveBarber -- unlike every
 * other /me route, this is the one a pending/rejected/suspended barber must
 * be able to reach. Powers client/src/pages/BarberStatusPage.js: the status
 * message itself, and prefilling the "edit and resubmit" form after a
 * rejection with whatever they submitted last time, so they are not forced
 * to retype it from scratch.
 */
const getMyApplicationStatus = async (req, res) => {
  const profile = await BarberProfile.findOne({ user: req.user._id });

  res.status(200).json({
    status: req.user.status,
    rejectionReason: req.user.rejectionReason,
    profile: profile ? profile.toOwnerJSON() : null,
  });
};

/**
 * GET /api/barbers/me
 * Barber only. Their own profile, including the isPublished switch.
 *
 * OWNERSHIP: the profile is looked up by req.user._id, which came from the
 * verified JWT. There is no id in the URL to tamper with.
 */
const getMyBarberProfile = async (req, res) => {
  const profile = await BarberProfile.findOne({ user: req.user._id });

  if (!profile) {
    // Not an error: a new barber simply has not filled theirs in yet.
    return res.status(200).json({ profile: null });
  }

  res.status(200).json({ profile: profile.toOwnerJSON() });
};

/**
 * PUT /api/barbers/me
 * Barber only. Creates the profile if missing, updates it if it exists.
 *
 * WHY ONE ROUTE FOR BOTH:
 * From the barber's point of view there is only ever one action: "save my
 * shop details". Making the frontend decide between POST and PUT invites
 * bugs with no benefit.
 *
 * SECURITY NOTE - FIELD ALLOW-LIST:
 * We copy named fields one at a time. We never do
 *     Object.assign(profile, req.body)
 * because that lets a caller write ANY field, including ones we add later.
 * Listing them is more typing and far safer.
 */
const upsertMyBarberProfile = async (req, res) => {
  const {
    shopName,
    bio,
    city,
    region,
    country,
    addressLine,
    latitude,
    longitude,
    locationConfirmed,
    publicPhone,
    timeZone,
    workingHours,
    isPublished,
    isAcceptingBookings,
    photoUrl,
    experience,
    specialties,
    requestedServices,
  } = req.body;

  let profile = await BarberProfile.findOne({ user: req.user._id });

  if (!profile) {
    profile = new BarberProfile({ user: req.user._id });
  }

  profile.shopName = shopName;
  profile.city = city;
  profile.timeZone = timeZone;
  profile.bio = bio || "";
  profile.region = region || "";
  profile.country = country || "";
  profile.addressLine = addressLine || "";
  profile.publicPhone = publicPhone || "";
  profile.photoUrl = photoUrl || "";
  profile.experience = experience || "";

  /**
   * Coordinates only get SAVED when the barber explicitly confirmed a
   * pick (locationConfirmed: true from the client's LocationField -- see
   * that component for how it distinguishes "still typing" from "picked
   * a suggestion"). Sending false, or omitting it, clears any previously
   * saved coordinates rather than leaving stale ones behind attached to a
   * city the barber has since changed.
   */
  if (locationConfirmed === true && Number.isFinite(latitude) && Number.isFinite(longitude)) {
    profile.latitude = latitude;
    profile.longitude = longitude;
    profile.locationConfirmed = true;
  } else {
    profile.latitude = null;
    profile.longitude = null;
    profile.locationConfirmed = false;
  }
  if (Array.isArray(specialties)) profile.specialties = specialties;
  if (Array.isArray(requestedServices)) profile.requestedServices = requestedServices;

  // Rebuild all seven days from what was sent, so a missing day means
  // closed rather than silently keeping an old value. Shared with the
  // admin profile editor -- see utils/workingHours.js.
  if (Array.isArray(workingHours)) {
    profile.workingHours = buildWorkingHours(workingHours);
  }

  if (typeof isPublished === "boolean") profile.isPublished = isPublished;
  if (typeof isAcceptingBookings === "boolean") {
    profile.isAcceptingBookings = isAcceptingBookings;
  }

  // .save() runs all the schema validators and the pre("validate") hook
  // that checks closing time is after opening time.
  await profile.save();

  res.status(200).json({
    message: "Shop details saved.",
    profile: profile.toOwnerJSON(),
  });
};

/**
 * PATCH /api/barbers/me/resubmit
 * Barber only. The "optionally allow barber to submit application again"
 * half of the reject flow -- see the spec's REJECT section. Reuses the same
 * field allow-list as PUT /me (the barber can correct whatever got them
 * rejected) but only actually moves status when the account is currently
 * "rejected"; calling it in any other state is a no-op on status and just
 * saves the edited profile fields, same as a normal PUT /me would.
 */
const resubmitApplication = async (req, res) => {
  const {
    shopName, bio, city, addressLine, publicPhone, timeZone, workingHours,
    photoUrl, experience, specialties, requestedServices,
  } = req.body;

  let profile = await BarberProfile.findOne({ user: req.user._id });
  if (!profile) {
    profile = new BarberProfile({ user: req.user._id });
  }

  profile.shopName = shopName;
  profile.city = city;
  profile.timeZone = timeZone;
  profile.bio = bio || "";
  profile.addressLine = addressLine || "";
  profile.publicPhone = publicPhone || "";
  profile.photoUrl = photoUrl || "";
  profile.experience = experience || "";
  if (Array.isArray(specialties)) profile.specialties = specialties;
  if (Array.isArray(requestedServices)) profile.requestedServices = requestedServices;
  if (Array.isArray(workingHours)) profile.workingHours = buildWorkingHours(workingHours);

  await profile.save();

  if (req.user.status === "rejected") {
    req.user.status = "pending_approval";
    req.user.rejectionReason = "";
    await req.user.save();
  }

  res.status(200).json({
    message: "Application resubmitted. Your account is waiting for VEYRON admin approval again.",
    profile: profile.toOwnerJSON(),
    user: req.user.toPublicJSON(),
  });
};

module.exports = {
  listPublicBarbers,
  getPublicBarber,
  getMyBarberProfile,
  upsertMyBarberProfile,
  resubmitApplication,
  getMyApplicationStatus,
};
