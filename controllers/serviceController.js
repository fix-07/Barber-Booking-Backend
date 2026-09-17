const Service = require("../models/Service");
const Booking = require("../models/Booking");

/**
 * GET /api/services/mine
 * Barber only. Every service they own, active or not.
 *
 * OWNERSHIP: filtered by req.user._id from the verified token. A barber
 * cannot ask for someone else's list, because there is nowhere to put
 * another id.
 */
const listMyServices = async (req, res) => {
  const services = await Service.find({ barber: req.user._id }).sort({
    name: 1,
  });

  res.status(200).json({
    services: services.map((service) => service.toPublicJSON()),
  });
};

/**
 * POST /api/services
 * Barber only. Creates a service owned by the logged-in barber.
 *
 * THE KEY LINE IS  barber: req.user._id
 *
 * Notice what is NOT here: we never read a barber id from req.body. If we
 * did, any barber could POST { "barber": "<someone else's id>" } and create
 * services inside another barber's shop. The owner is always taken from the
 * verified token, never from the request.
 */
const createService = async (req, res) => {
  const { name, description, durationMinutes, priceMinor, currency } = req.body;

  const service = await Service.create({
    barber: req.user._id,
    name,
    description: description || "",
    durationMinutes,
    priceMinor,
    currency,
  });

  res.status(201).json({
    message: "Service created.",
    service: service.toPublicJSON(),
  });
};

/**
 * PUT /api/services/:id
 * Barber only, and only their OWN service.
 *
 * THE OWNERSHIP CHECK, and why it is written this way:
 *
 * We query  { _id: id, barber: req.user._id }  in ONE step rather than
 * fetching by id and then comparing. Two reasons:
 *   1. There is no window between "load" and "check" for a mistake to
 *      creep in, and no way to forget the check later.
 *   2. A service belonging to someone else returns null, so the caller
 *      gets a plain 404. We do not reveal that the id exists but belongs
 *      to another barber.
 */
const updateService = async (req, res) => {
  const service = await Service.findOne({
    _id: req.params.id,
    barber: req.user._id,
  });

  if (!service) {
    return res.status(404).json({errors : [{message: "Service not found"}]});
  }

  const { name, description, durationMinutes, priceMinor, currency, isActive } =
    req.body;

  // Field allow-list again: assign only what we name.
  if (name !== undefined) service.name = name;
  if (description !== undefined) service.description = description;
  if (durationMinutes !== undefined) service.durationMinutes = durationMinutes;
  if (priceMinor !== undefined) service.priceMinor = priceMinor;
  if (currency !== undefined) service.currency = currency;
  if (typeof isActive === "boolean") service.isActive = isActive;

  await service.save();

  res.status(200).json({
    message: "Service updated.",
    service: service.toPublicJSON(),
  });
};

/**
 * DELETE /api/services/:id
 * Barber only, and only their OWN service.
 *
 * WHY THIS SOMETIMES DEACTIVATES INSTEAD OF DELETING:
 * Bookings snapshot the service name and price, so old bookings survive a
 * deletion. But a service with UPCOMING appointments is different: deleting
 * it would leave the barber with appointments for something no longer on
 * their list, and nothing to click in the UI. So if future live bookings
 * exist we deactivate it instead, which hides it from customers while
 * keeping those appointments intact, and we say clearly that is what
 * happened rather than pretending we deleted it.
 */
const deleteService = async (req, res) => {
  const service = await Service.findOne({
    _id: req.params.id,
    barber: req.user._id,
  });

  if (!service) {
    return res.status(404).json({errors : [{message: "Service not found"}]});
  }

  const upcomingCount = await Booking.countDocuments({
    service: service._id,
    holdsSlot: true,
    startAt: { $gte: new Date() },
  });

  if (upcomingCount > 0) {
    service.isActive = false;
    await service.save();

    return res.status(200).json({
      message:
        `This service has ${upcomingCount} upcoming appointment(s), so it was ` +
        `hidden from customers instead of deleted. Those appointments are unchanged.`,
      service: service.toPublicJSON(),
      deactivatedInsteadOfDeleted: true,
    });
  }

  await service.deleteOne();

  res.status(200).json({
    message: "Service deleted.",
    deactivatedInsteadOfDeleted: false,
  });
};

module.exports = {
  listMyServices,
  createService,
  updateService,
  deleteService,
};
