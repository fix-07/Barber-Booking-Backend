const mongoose = require("mongoose");

/**
 * A SINGLETON document: business-wide facts the admin Settings page edits
 * and the customer-facing site (Footer, the four legal pages) reads.
 *
 * WHY THIS EXISTS, AND WHY IT DID NOT BEFORE:
 * client/src/config/business.js was, until now, a static file baked into
 * the frontend build -- editing it meant redeploying the whole site. That
 * was a deliberate, honest starting point (see that file's own comments),
 * but it also means an admin "Settings" page that only wrote to a database
 * nobody read would be exactly the kind of decorative control this project
 * has avoided everywhere else: a form that appears to work but changes
 * nothing a customer ever sees. This model is what makes it real.
 *
 * getOrCreate() always returns the one document, seeding it from the exact
 * same bracketed placeholders business.js used to hard-code, so nothing
 * regresses to blank on first deploy after this change -- the Placeholder
 * component on the frontend still highlights whatever is still a "[...]"
 * value, exactly as before.
 */
const businessSettingsSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, maxlength: 120, default: "VEYRON" },
    legalName: { type: String, trim: true, maxlength: 160, default: "VEYRON" },
    email: { type: String, trim: true, maxlength: 254, default: "[BUSINESS EMAIL]" },
    phone: { type: String, trim: true, maxlength: 30, default: "[BUSINESS PHONE]" },
    address: { type: String, trim: true, maxlength: 300, default: "[BUSINESS ADDRESS]" },
    registration: {
      type: String,
      trim: true,
      maxlength: 120,
      default: "[COMPANY OR TAX REGISTRATION NUMBER, IF ANY]",
    },
    hours: { type: String, trim: true, maxlength: 300, default: "[BUSINESS HOURS]" },
    jurisdiction: { type: String, trim: true, maxlength: 120, default: "[APPLICABLE JURISDICTION]" },
    policyUpdated: {
      type: String,
      trim: true,
      maxlength: 60,
      default: "[DATE YOU LAST REVIEWED THESE POLICIES]",
    },
    // Free text, same plain-language-prose approach the rest of the legal
    // pages already use rather than a structured, enforced rule -- nothing
    // in the booking/cancellation logic reads a numeric "notice period"
    // today, so a control implying one would not actually do anything.
    cancellationPolicy: { type: String, trim: true, maxlength: 2000, default: "" },
  },
  { timestamps: true }
);

businessSettingsSchema.methods.toJSON = function () {
  return {
    name: this.name,
    legalName: this.legalName,
    email: this.email,
    phone: this.phone,
    address: this.address,
    registration: this.registration,
    hours: this.hours,
    jurisdiction: this.jurisdiction,
    policyUpdated: this.policyUpdated,
    cancellationPolicy: this.cancellationPolicy,
    updatedAt: this.updatedAt,
  };
};

const BusinessSettings = mongoose.model("BusinessSettings", businessSettingsSchema);

/** There is ever only one of these. Creates it with defaults on first use. */
BusinessSettings.getOrCreate = async function () {
  let settings = await BusinessSettings.findOne();
  if (!settings) settings = await BusinessSettings.create({});
  return settings;
};

module.exports = BusinessSettings;
