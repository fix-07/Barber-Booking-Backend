const BusinessSettings = require("../models/BusinessSettings");
const { recordAudit } = require("../utils/auditLog");

/** GET /api/admin/settings */
const getAdminSettings = async (req, res) => {
  const settings = await BusinessSettings.getOrCreate();
  res.status(200).json({ business: settings.toJSON() });
};

/**
 * PATCH /api/admin/settings
 * Field allow-list, same convention as every other update endpoint in this
 * codebase. Every field this writes is actually read by the public
 * GET /api/settings the customer-facing site calls -- see the note on
 * models/BusinessSettings.js for why that mattered enough to build.
 */
const updateAdminSettings = async (req, res) => {
  const settings = await BusinessSettings.getOrCreate();

  const {
    name, legalName, email, phone, address,
    registration, hours, jurisdiction, policyUpdated, cancellationPolicy,
  } = req.body;

  if (name !== undefined) settings.name = name;
  if (legalName !== undefined) settings.legalName = legalName;
  if (email !== undefined) settings.email = email;
  if (phone !== undefined) settings.phone = phone;
  if (address !== undefined) settings.address = address;
  if (registration !== undefined) settings.registration = registration;
  if (hours !== undefined) settings.hours = hours;
  if (jurisdiction !== undefined) settings.jurisdiction = jurisdiction;
  if (policyUpdated !== undefined) settings.policyUpdated = policyUpdated;
  if (cancellationPolicy !== undefined) settings.cancellationPolicy = cancellationPolicy;

  await settings.save();

  // Log WHICH fields changed, never their values: business settings hold
  // contact details, and an audit list is not the place to duplicate them.
  const changedFields = Object.keys(req.body).filter((key) => req.body[key] !== undefined);
  await recordAudit(req, {
    action: "settings.update",
    resourceType: "settings",
    resourceId: settings._id,
    summary: changedFields.length
      ? `Updated business settings: ${changedFields.join(", ")}.`
      : "Saved business settings with no field changes.",
  });

  res.status(200).json({ message: "Settings saved.", business: settings.toJSON() });
};

module.exports = { getAdminSettings, updateAdminSettings };
