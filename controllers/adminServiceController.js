const Service = require("../models/Service");
const Booking = require("../models/Booking");
const User = require("../models/User");
const { readPaging } = require("../utils/queryHelpers");
const { recordAudit } = require("../utils/auditLog");

/**
 * GET /api/admin/services
 * Every barber's services in one list -- serviceController.listMyServices
 * is scoped to req.user._id, which is exactly what a barber should see and
 * exactly what staff managing the whole shop should not be limited to.
 */
const listAllServices = async (req, res) => {
  const { page, limit, skip } = readPaging(req.query);
  const filter = {};

  if (req.query.barberId) filter.barber = req.query.barberId;
  if (req.query.isActive === "true") filter.isActive = true;
  if (req.query.isActive === "false") filter.isActive = false;

  const [services, total] = await Promise.all([
    Service.find(filter)
      .populate("barber", "name")
      .sort({ name: 1 })
      .skip(skip)
      .limit(limit),
    Service.countDocuments(filter),
  ]);

  // Real upcoming-appointment counts, one aggregate query for the whole
  // page -- used by the "Delete" confirmation to warn about appointments
  // still on the books, the same way client/barber delete already do. It
  // does NOT block deletion: Booking snapshots service name/price/duration
  // independently (serviceNameAtBooking etc.), so deleting the Service
  // document itself never corrupts an existing booking's record.
  const now = new Date();
  const upcomingCounts = await Booking.aggregate([
    { $match: { service: { $in: services.map((s) => s._id) }, holdsSlot: true, startAt: { $gte: now } } },
    { $group: { _id: "$service", count: { $sum: 1 } } },
  ]);
  const upcomingMap = new Map(upcomingCounts.map((c) => [String(c._id), c.count]));

  res.status(200).json({
    services: services.map((service) => ({
      ...service.toPublicJSON(),
      barberName: service.barber?.name,
      upcomingBookingsCount: upcomingMap.get(String(service._id)) || 0,
    })),
    page,
    limit,
    total,
  });
};

/**
 * POST /api/admin/services
 * Same shape as serviceController.createService, except the owning barber
 * is chosen by staff (barberId in the body) rather than always being
 * req.user._id. Services stay single-barber-owned, as they are throughout
 * this codebase -- see the model comment on Service.barber.
 */
const createServiceForBarber = async (req, res) => {
  const { barberId, name, description, durationMinutes, priceMinor, currency } = req.body;

  const barber = await User.findOne({ _id: barberId, role: "barber" });
  if (!barber) {
    return res.status(404).json({ errors: [{ message: "That barber could not be found", path: "barberId" }] });
  }

  const service = await Service.create({
    barber: barberId,
    name,
    description: description || "",
    durationMinutes,
    priceMinor,
    currency,
  });

  res.status(201).json({ message: "Service created.", service: service.toPublicJSON() });
};

/**
 * PATCH /api/admin/services/:id
 * Same field allow-list as serviceController.updateService, minus the
 * ownership filter -- staff can edit any barber's service.
 */
const updateAnyService = async (req, res) => {
  const service = await Service.findById(req.params.id);
  if (!service) {
    return res.status(404).json({ errors: [{ message: "Service not found" }] });
  }

  const { name, description, durationMinutes, priceMinor, currency, isActive } = req.body;

  if (name !== undefined) service.name = name;
  if (description !== undefined) service.description = description;
  if (durationMinutes !== undefined) service.durationMinutes = durationMinutes;
  if (priceMinor !== undefined) service.priceMinor = priceMinor;
  if (currency !== undefined) service.currency = currency;
  if (typeof isActive === "boolean") service.isActive = isActive;

  await service.save();

  res.status(200).json({ message: "Service updated.", service: service.toPublicJSON() });
};

/**
 * DELETE /api/admin/services/:id
 * A REAL, permanent delete -- the Service document is removed from the
 * database, full stop. This intentionally does NOT fall back to
 * deactivating even when upcoming bookings reference it: Booking already
 * snapshots serviceNameAtBooking/durationMinutesAtBooking/
 * priceMinorAtBooking/currencyAtBooking at creation time (see
 * models/Booking.js), so those bookings keep reading correctly forever with
 * no dependency on the Service document surviving. The frontend fetches
 * upcomingBookingsCount (see listAllServices above) to warn the admin
 * before they confirm, the same way client/barber delete already do --
 * warn, then let the admin decide, never silently block.
 *
 * The still-separate barber-only serviceController.deleteService keeps its
 * own deactivate-if-referenced behavior -- that one is a BARBER managing
 * their own live shop, where losing a bookable service out from under an
 * upcoming appointment without warning is a worse default. This is admin,
 * who asked for "Delete means actually delete", explicitly, everywhere.
 */
const deleteAnyService = async (req, res) => {
  const service = await Service.findById(req.params.id);
  if (!service) {
    return res.status(404).json({ errors: [{ message: "Service not found" }] });
  }

  await service.deleteOne();

  await recordAudit(req, {
    action: "service.delete",
    resourceType: "service",
    resourceId: service._id,
    summary: `Permanently deleted service "${service.name}". Existing bookings keep their own saved copy of the name, price and duration.`,
  });

  res.status(200).json({ message: "Service permanently deleted." });
};

module.exports = { listAllServices, createServiceForBarber, updateAnyService, deleteAnyService };
