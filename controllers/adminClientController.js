const User = require("../models/User");
const Booking = require("../models/Booking");
const { findOrCreateWalkInCustomer } = require("../utils/walkInUser");
const { escapeRegex, readPaging } = require("../utils/queryHelpers");
const { recordAudit } = require("../utils/auditLog");

/**
 * GET /api/admin/clients?q=
 * Search customers by name, email or phone. There is no equivalent search
 * anywhere else in the codebase -- every existing query is scoped to the
 * logged-in user's own id.
 */
const listClients = async (req, res) => {
  const { page, limit, skip } = readPaging(req.query);
  const filter = { role: "customer" };

  if (req.query.q) {
    const term = escapeRegex(String(req.query.q).slice(0, 80));
    const pattern = new RegExp(term, "i");
    filter.$or = [{ name: pattern }, { email: pattern }, { phone: pattern }];
  }

  const [clients, total] = await Promise.all([
    User.find(filter).sort({ name: 1 }).skip(skip).limit(limit),
    User.countDocuments(filter),
  ]);

  const clientIds = clients.map((c) => c._id);

  // Two aggregations, computed only for this one page of clients, so a
  // large customer base does not mean scanning every booking on every page
  // load. Real numbers -- see getClient below for the same computation on
  // a single client's own page.
  const [visitStats, favoriteServiceRows] = await Promise.all([
    Booking.aggregate([
      // A cancelled booking was never a visit, so it must not count toward
      // lastVisit either -- match on real bookings up front rather than
      // only excluding cancellations from the two $sum fields, which
      // would leave lastVisit reporting a date nobody actually came in.
      { $match: { customer: { $in: clientIds }, status: { $in: Booking.SLOT_HOLDING_STATUSES } } },
      {
        $group: {
          _id: "$customer",
          lastVisit: { $max: "$startAt" },
          totalVisits: { $sum: 1 },
          totalSpentMinor: {
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
    ]),

    // Sort-then-group-with-$first is the standard aggregation pattern for
    // "top row per group": $group processes documents in the order they
    // arrive, so the $sort immediately before it decides which row $first
    // keeps for each customer.
    Booking.aggregate([
      { $match: { customer: { $in: clientIds }, status: { $in: Booking.SLOT_HOLDING_STATUSES } } },
      { $group: { _id: { customer: "$customer", service: "$serviceNameAtBooking" }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $group: { _id: "$_id.customer", favoriteService: { $first: "$_id.service" } } },
    ]),
  ]);

  const visitMap = new Map(visitStats.map((v) => [String(v._id), v]));
  const favoriteMap = new Map(favoriteServiceRows.map((f) => [String(f._id), f.favoriteService]));

  res.status(200).json({
    clients: clients.map((client) => {
      const stats = visitMap.get(String(client._id));
      const totalVisits = stats?.totalVisits || 0;
      return {
        ...client.toAdminJSON(),
        totalVisits,
        lastVisit: stats?.lastVisit || null,
        totalSpentMinor: stats?.totalSpentMinor || 0,
        favoriteService: favoriteMap.get(String(client._id)) || null,
        // Derived directly from real visit data, not a separate stored
        // field: "active" once they have at least one real booking, "new"
        // otherwise. Nothing invented. Named `engagementStatus`, NOT
        // `status` -- `status` already means the ACCOUNT's active/suspended
        // state (see suspendClient/reactivateClient below, and
        // User.toPublicJSON). Calling this "status" too would silently
        // overwrite the real account status in every object spread above.
        engagementStatus: totalVisits > 0 ? "active" : "new",
      };
    }),
    page,
    limit,
    total,
  });
};

/**
 * GET /api/admin/clients/:id
 * A client's profile plus their booking history, computed the way nothing
 * else in the codebase needed to before: aggregated across ALL their
 * bookings, not filtered to one barber's view of them.
 */
const getClient = async (req, res) => {
  const client = await User.findOne({ _id: req.params.id, role: "customer" });
  if (!client) {
    return res.status(404).json({ errors: [{ message: "Client not found" }] });
  }

  const bookings = await Booking.find({ customer: client._id })
    .populate("barber", "name")
    .sort({ startAt: -1 })
    .limit(500);

  const now = new Date();
  const upcoming = bookings.filter((b) => b.holdsSlot && b.startAt >= now);

  // "Happened or intended to happen" bookings -- excludes anything
  // cancelled, matching Booking.SLOT_HOLDING_STATUSES.
  const real = bookings.filter((b) => Booking.SLOT_HOLDING_STATUSES.includes(b.status));

  const totalSpentMinor = bookings
    .filter((b) => b.status === "completed" && b.payment?.status === "paid")
    .reduce((sum, b) => sum + b.priceMinorAtBooking, 0);

  const serviceCounts = {};
  for (const booking of real) {
    serviceCounts[booking.serviceNameAtBooking] =
      (serviceCounts[booking.serviceNameAtBooking] || 0) + 1;
  }
  const favoriteService =
    Object.entries(serviceCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  res.status(200).json({
    client: client.toAdminJSON(),
    favoriteService,
    totalSpentMinor,
    totalVisits: real.length,
    // `bookings` is sorted newest-first and filter() preserves that order,
    // so the first real (non-cancelled) entry is the most recent one --
    // same "a cancelled booking was never a visit" rule as listClients.
    lastVisit: real[0]?.startAt || null,
    upcomingAppointments: upcoming.map((b) => b.toJSONFor("admin")),
    bookingHistory: bookings.map((b) => b.toJSONFor("admin")),
  });
};

/**
 * POST /api/admin/clients
 * Adds a client record without a booking attached yet -- e.g. someone rings
 * up to ask about opening hours and staff want them findable later.
 */
const createClient = async (req, res) => {
  const { name, email, phone } = req.body;

  let client;
  try {
    client = await findOrCreateWalkInCustomer({ name, email, phone });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ errors: [{ message: error.message }] });
  }

  res.status(201).json({ message: "Client added.", client: client.toAdminJSON() });
};

/**
 * PATCH /api/admin/clients/:id
 * Field allow-list, same convention as every other update endpoint in this
 * codebase (see serviceController.updateService for the same pattern).
 */
const updateClient = async (req, res) => {
  const client = await User.findOne({ _id: req.params.id, role: "customer" });
  if (!client) {
    return res.status(404).json({ errors: [{ message: "Client not found" }] });
  }

  const { name, phone, email, adminNotes } = req.body;

  if (name !== undefined) client.name = name;
  if (phone !== undefined) client.phone = phone;
  if (adminNotes !== undefined) client.adminNotes = adminNotes;

  if (email !== undefined && email !== client.email) {
    const normalizedEmail = String(email).trim().toLowerCase();
    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(409).json({ errors: [{ message: "That email is already in use", path: "email" }] });
    }
    client.email = normalizedEmail;
  }

  await client.save();

  res.status(200).json({ message: "Client updated.", client: client.toAdminJSON() });
};

/**
 * DELETE /api/admin/clients/:id
 * Permanently deletes the account and every piece of personal data on it
 * (name, email, phone, adminNotes -- the whole User document). Their
 * bookings are never touched: booking history is not "the client's data"
 * in the same sense, it is the shop's own record of what happened, and
 * server/models/Booking.js already exists specifically to survive the
 * things it references changing or disappearing (see the price/service
 * snapshot fields there, and customerNameAtBooking below, which is the
 * exact same idea applied to the account itself).
 *
 * Future bookings are left exactly as they are -- not cancelled, not
 * deleted -- because deleting an account is not the same thing as
 * cancelling an appointment the shop still expects to happen. The
 * confirmation UI is what warns the admin about them; this endpoint does
 * not need to re-decide that, only make sure they keep reading correctly.
 */
const deleteClient = async (req, res) => {
  const client = await User.findOne({ _id: req.params.id, role: "customer" });
  if (!client) {
    return res.status(404).json({ errors: [{ message: "Client not found" }] });
  }

  // One-time snapshot of the name onto every booking this client ever
  // made, past or future, so toJSONFor() keeps showing a real name forever
  // instead of falling back to the generic "Deleted client" label -- see
  // the field comment on Booking.customerNameAtBooking for why this is
  // done here, once, rather than on every booking as it is created.
  await Booking.updateMany({ customer: client._id }, { $set: { customerNameAtBooking: client.name } });

  await client.deleteOne();

  await recordAudit(req, {
    action: "client.delete",
    resourceType: "client",
    resourceId: client._id,
    summary: `Permanently deleted client ${client.name} (${client.email}) and their personal data. Booking history preserved.`,
  });

  res.status(200).json({ message: "Client deleted." });
};

/**
 * PATCH /api/admin/clients/:id/suspend
 * ADMIN FULL CONTROL: blocks the account without deleting anything --
 * reversible via reactivateClient below, unlike deleteClient. A suspended
 * client cannot log in at all (see authController.login's role==="customer"
 * check) or create new bookings even with an existing session (see
 * requireActiveCustomer in middleware/auth.js) -- their existing booking
 * history is untouched either way.
 */
const suspendClient = async (req, res) => {
  const client = await User.findOne({ _id: req.params.id, role: "customer" });
  if (!client) {
    return res.status(404).json({ errors: [{ message: "Client not found" }] });
  }

  client.status = "suspended";
  await client.save();

  await recordAudit(req, {
    action: "client.suspend",
    resourceType: "client",
    resourceId: client._id,
    summary: `Suspended client ${client.name} (${client.email}). They can no longer log in or book.`,
  });

  res.status(200).json({ message: "Client suspended.", clientId: client._id, status: client.status });
};

/** PATCH /api/admin/clients/:id/reactivate */
const reactivateClient = async (req, res) => {
  const client = await User.findOne({ _id: req.params.id, role: "customer" });
  if (!client) {
    return res.status(404).json({ errors: [{ message: "Client not found" }] });
  }

  client.status = "active";
  await client.save();

  await recordAudit(req, {
    action: "client.reactivate",
    resourceType: "client",
    resourceId: client._id,
    summary: `Reactivated client ${client.name} (${client.email}). They can log in and book again.`,
  });

  res.status(200).json({ message: "Client reactivated.", clientId: client._id, status: client.status });
};

module.exports = {
  listClients, getClient, createClient, updateClient, deleteClient,
  suspendClient, reactivateClient,
};
