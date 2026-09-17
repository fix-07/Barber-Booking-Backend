const mongoose = require("mongoose");
const { timeToMinutes, isValidTimeZone } = require("../utils/schedule");

/**
 * One day's opening hours.
 * day: 0 = Sunday, 1 = Monday ... 6 = Saturday
 * (This matches JavaScript's own Date.getDay(), so there is one less
 * thing to remember.)
 */
const workingHourSchema = new mongoose.Schema(
  {
    day: {
      type: Number,
      required: true,
      min: 0,
      max: 6,
    },
    isOpen: {
      type: Boolean,
      default: false,
    },
    open: {
      type: String, // "09:00"
      default: "09:00",
      validate: {
        validator: (v) => timeToMinutes(v) !== null,
        message: "Opening time must look like 09:00 (24-hour clock).",
      },
    },
    close: {
      type: String, // "18:00"
      default: "18:00",
      validate: {
        validator: (v) => timeToMinutes(v) !== null,
        message: "Closing time must look like 18:00 (24-hour clock).",
      },
    },

    // An optional single break within the open day, e.g. lunch. Both must
    // be set together or not at all -- see the pre("validate") hook below,
    // which also checks the break actually falls inside open/close.
    breakStart: {
      type: String,
      default: "",
      validate: {
        validator: (v) => !v || timeToMinutes(v) !== null,
        message: "Break start must look like 13:00 (24-hour clock).",
      },
    },
    breakEnd: {
      type: String,
      default: "",
      validate: {
        validator: (v) => !v || timeToMinutes(v) !== null,
        message: "Break end must look like 13:30 (24-hour clock).",
      },
    },
  },
  { _id: false }
);

/**
 * A one-off closure: a holiday, a day off, or any blocked range of calendar
 * dates. Separate from workingHours, which is the recurring WEEKLY pattern.
 *
 * Dates are stored as "YYYY-MM-DD" strings in the shop's own timezone, not
 * as Date objects -- see the long comment on getLocalDateKey in
 * utils/schedule.js for why a calendar date is a string key here, not a
 * precise instant.
 */
const timeOffSchema = new mongoose.Schema(
  {
    startDate: {
      type: String,
      required: true,
      match: [/^\d{4}-\d{2}-\d{2}$/, "Start date must look like 2026-12-25."],
    },
    endDate: {
      type: String,
      required: true,
      match: [/^\d{4}-\d{2}-\d{2}$/, "End date must look like 2026-12-25."],
    },
    reason: {
      type: String,
      trim: true,
      maxlength: [200, "Reason cannot be longer than 200 characters"],
      default: "",
    },
  },
  { timestamps: true }
);

/**
 * A barber's public shop details.
 *
 * WHY THIS IS SEPARATE FROM User:
 * The User document holds private account data (email, password hash).
 * This document holds the information that is meant to be PUBLIC on the
 * barber's listing. Keeping them apart means a public endpoint can return
 * a whole BarberProfile without any risk of leaking account data, because
 * the account data is simply not in here.
 *
 * DATA MINIMIZATION NOTE:
 * "city" exists so customers can find a barber near them, which is the
 * core purpose of the site. There is no GPS coordinate, no precise
 * geolocation, and no tracking. The street address is optional, because
 * some barbers are mobile or share a space and may not want it listed.
 */
const barberProfileSchema = new mongoose.Schema(
  {
    // The barber who owns this profile. "unique" enforces one profile
    // per barber at the database level, not just in our code.
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },

    shopName: {
      type: String,
      required: [true, "Shop or business name is required"],
      trim: true,
      minlength: [2, "Shop name must be at least 2 characters"],
      maxlength: [80, "Shop name cannot be longer than 80 characters"],
    },

    bio: {
      type: String,
      trim: true,
      maxlength: [600, "Description cannot be longer than 600 characters"],
      default: "",
    },

    city: {
      type: String,
      required: [true, "City or town is required"],
      trim: true,
      maxlength: [80, "City cannot be longer than 80 characters"],
    },

    addressLine: {
      type: String,
      trim: true,
      maxlength: [160, "Address cannot be longer than 160 characters"],
      default: "",
    },

    // Free-text region/state and country, from the same location picker
    // as city -- see LocationField.js on the client and
    // controllers/geocodeController.js for where the suggestions come
    // from. Both optional: a barber can save just a city, same as before
    // this field existed.
    region: {
      type: String,
      trim: true,
      maxlength: [80, "Region cannot be longer than 80 characters"],
      default: "",
    },
    country: {
      type: String,
      trim: true,
      maxlength: [80, "Country cannot be longer than 80 characters"],
      default: "",
    },

    /**
     * Real map coordinates, ONLY when a barber has actually confirmed a
     * specific location on the map/suggestion list -- never a silent
     * guess. `locationConfirmed` is the honesty flag the spec explicitly
     * asks for: a profile can have a city with no confirmed coordinates
     * (locationConfirmed: false, latitude/longitude both null), and the
     * frontend must not claim otherwise (see BarberDetailPage.js, which
     * only renders a map when this is true).
     */
    latitude: {
      type: Number,
      min: [-90, "Latitude must be between -90 and 90"],
      max: [90, "Latitude must be between -90 and 90"],
      default: null,
    },
    longitude: {
      type: Number,
      min: [-180, "Longitude must be between -180 and 180"],
      max: [180, "Longitude must be between -180 and 180"],
      default: null,
    },
    locationConfirmed: {
      type: Boolean,
      default: false,
    },

    // A business contact number the barber CHOOSES to publish.
    // Separate from the phone on their User account, which stays private.
    publicPhone: {
      type: String,
      trim: true,
      maxlength: [30, "Phone number is too long"],
      default: "",
    },

    // IANA timezone of the shop, e.g. "Europe/London".
    // See utils/schedule.js for why this is necessary.
    timeZone: {
      type: String,
      required: [true, "Shop timezone is required"],
      validate: {
        validator: isValidTimeZone,
        message:
          "Timezone must be a recognised name such as Europe/London or America/New_York.",
      },
    },

    workingHours: {
      type: [workingHourSchema],
      default: () =>
        [0, 1, 2, 3, 4, 5, 6].map((day) => ({
          day,
          // Default to closed. The barber opts each day IN, rather than
          // us inventing a schedule they never agreed to.
          isOpen: false,
          open: "09:00",
          close: "18:00",
        })),
    },

    // The barber controls whether they appear in public search results.
    isPublished: {
      type: Boolean,
      default: false,
    },

    // A quick "on holiday" switch that hides the booking button without
    // unpublishing the whole profile.
    isAcceptingBookings: {
      type: Boolean,
      default: true,
    },

    // One-off closures: holidays, days off, anything outside the normal
    // weekly pattern. See timeOffSchema above.
    timeOff: {
      type: [timeOffSchema],
      default: [],
    },

    /**
     * APPLICATION FIELDS -- filled in at signup (see authController.register)
     * and shown to an admin reviewing the application (see
     * adminBarberApprovalController.js). They keep making sense after
     * approval too (a photo/specialties list is normal ongoing profile
     * content), except requestedServices, which is a one-time signal of
     * intent from before the barber could create real Service documents.
     */
    photoUrl: {
      type: String,
      trim: true,
      maxlength: [2000, "Photo link is too long"],
      default: "",
    },

    experience: {
      type: String,
      trim: true,
      maxlength: [500, "Experience cannot be longer than 500 characters"],
      default: "",
    },

    specialties: {
      type: [String],
      default: [],
      validate: {
        validator: (list) => list.length <= 10 && list.every((s) => s.length <= 40),
        message: "Up to 10 specialties, each 40 characters or fewer.",
      },
    },

    // Free-text services the applicant intends to offer -- informational
    // only, for the admin reviewing the application. Real, bookable
    // services (with a price and duration) are created after approval via
    // POST /api/services.
    requestedServices: {
      type: [String],
      default: [],
      validate: {
        validator: (list) => list.length <= 10 && list.every((s) => s.length <= 80),
        message: "Up to 10 requested services, each 80 characters or fewer.",
      },
    },
  },
  { timestamps: true }
);

// Makes the public "barbers in this city" search fast.
barberProfileSchema.index({ isPublished: 1, city: 1 });

/**
 * Validates that every open day has a close time AFTER its open time.
 * A single-field validator cannot easily see sibling fields, so we check
 * the whole list here.
 *
 * MONGOOSE 9 NOTE - this caught me out, so it is worth writing down:
 * Mongoose 9 does NOT pass a "next" callback to document hooks at all,
 * whether the hook is async or not. Older tutorials written for Mongoose
 * 7/8 show
 *     function (next) { ...; next(); }
 * and in Mongoose 9 that crashes with "next is not a function".
 * Just return, and throw if you want to abort.
 */
barberProfileSchema.pre("validate", function () {
  for (const entry of this.workingHours || []) {
    if (!entry.isOpen) continue;

    const opensAt = timeToMinutes(entry.open);
    const closesAt = timeToMinutes(entry.close);

    if (opensAt === null || closesAt === null) continue; // field validators report this

    if (closesAt <= opensAt) {
      this.invalidate(
        "workingHours",
        "Closing time must be later than opening time on every open day."
      );
      break;
    }

    // A break is optional, but if either side is set, both must be, and it
    // must sit inside the open hours it is supposedly interrupting.
    const hasBreakStart = Boolean(entry.breakStart);
    const hasBreakEnd = Boolean(entry.breakEnd);

    if (hasBreakStart !== hasBreakEnd) {
      this.invalidate(
        "workingHours",
        "A break needs both a start and an end time."
      );
      break;
    }

    if (hasBreakStart && hasBreakEnd) {
      const breakStartMin = timeToMinutes(entry.breakStart);
      const breakEndMin = timeToMinutes(entry.breakEnd);

      if (
        breakStartMin === null ||
        breakEndMin === null ||
        breakEndMin <= breakStartMin ||
        breakStartMin < opensAt ||
        breakEndMin > closesAt
      ) {
        this.invalidate(
          "workingHours",
          "The break must end after it starts and fit inside that day's opening hours."
        );
        break;
      }
    }
  }

  for (const entry of this.timeOff || []) {
    if (entry.endDate < entry.startDate) {
      this.invalidate("timeOff", "A time-off range cannot end before it starts.");
      break;
    }
  }

  /**
   * Coordinates are a PAIR or NOTHING, and "confirmed" requires the pair.
   *
   * The alternative -- accepting a lone latitude with no longitude, or
   * letting locationConfirmed be true with null coordinates -- is exactly
   * the "claim a location is confirmed when it is not" failure mode the
   * spec calls out by name. Better to reject a half-saved location than
   * store something that LOOKS precise but is actually broken.
   */
  const hasLat = this.latitude !== null && this.latitude !== undefined;
  const hasLng = this.longitude !== null && this.longitude !== undefined;

  if (hasLat !== hasLng) {
    this.invalidate("latitude", "Latitude and longitude must be set together.");
  }

  if (this.locationConfirmed && !(hasLat && hasLng)) {
    this.invalidate("locationConfirmed", "A location cannot be confirmed without real coordinates.");
  }
});

/**
 * What the PUBLIC is allowed to see.
 * Note there is no email and no account phone number here.
 */
barberProfileSchema.methods.toPublicJSON = function () {
  // If the caller used .populate("user"), include the barber's display
  // name - but only the name, nothing else from the account.
  const barberName =
    this.user && this.user.name ? this.user.name : undefined;

  return {
    id: this._id,
    barberId: this.user && this.user._id ? this.user._id : this.user,
    barberName,
    shopName: this.shopName,
    bio: this.bio,
    city: this.city,
    region: this.region,
    country: this.country,
    addressLine: this.addressLine,
    // Only exposed when genuinely confirmed -- see the pre("validate")
    // hook above for why those two facts can never disagree. A public
    // profile page must never render a map pin from a half-saved or
    // guessed coordinate.
    latitude: this.locationConfirmed ? this.latitude : null,
    longitude: this.locationConfirmed ? this.longitude : null,
    locationConfirmed: this.locationConfirmed,
    publicPhone: this.publicPhone,
    timeZone: this.timeZone,
    workingHours: this.workingHours,
    isAcceptingBookings: this.isAcceptingBookings,
    timeOff: this.timeOff,
    photoUrl: this.photoUrl,
    specialties: this.specialties,
  };
};

/**
 * What the OWNER sees about their own profile: the public fields plus
 * the publish switch they control.
 */
barberProfileSchema.methods.toOwnerJSON = function () {
  return {
    ...this.toPublicJSON(),
    isPublished: this.isPublished,
    experience: this.experience,
    requestedServices: this.requestedServices,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

module.exports = mongoose.model("BarberProfile", barberProfileSchema);
