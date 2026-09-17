const mongoose = require("mongoose");

/**
 * A service a barber offers, for example "Skin fade - 45 min".
 *
 * WHY PRICE IS STORED AS A WHOLE NUMBER OF MINOR UNITS:
 * Money must never be stored as a decimal. In JavaScript,
 * 0.1 + 0.2 === 0.30000000000000004. Storing 1250 (meaning 12.50) as an
 * integer removes that whole class of bug. We divide by 100 only at the
 * moment we display it.
 *
 * WHY currency IS REQUIRED AND NOT DEFAULTED:
 * I do not know what currency your business uses, and guessing would be
 * inventing business information. The barber sets it when creating the
 * service.
 */
const serviceSchema = new mongoose.Schema(
  {
    // The barber who owns this service. Every ownership check compares
    // this against the logged-in user's id from their verified token.
    barber: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    name: {
      type: String,
      required: [true, "Service name is required"],
      trim: true,
      minlength: [2, "Service name must be at least 2 characters"],
      maxlength: [80, "Service name cannot be longer than 80 characters"],
    },

    description: {
      type: String,
      trim: true,
      maxlength: [400, "Description cannot be longer than 400 characters"],
      default: "",
    },

    durationMinutes: {
      type: Number,
      required: [true, "Duration is required"],
      min: [5, "Duration must be at least 5 minutes"],
      max: [480, "Duration cannot be longer than 8 hours"],
      validate: {
        validator: Number.isInteger,
        message: "Duration must be a whole number of minutes.",
      },
    },

    // Price in minor units: 1250 means 12.50
    priceMinor: {
      type: Number,
      required: [true, "Price is required"],
      min: [0, "Price cannot be negative"],
      max: [100000000, "Price is unrealistically high"],
      validate: {
        validator: Number.isInteger,
        message: "Price must be a whole number of minor units, for example 1250 for 12.50.",
      },
    },

    currency: {
      type: String,
      required: [true, "Currency is required"],
      uppercase: true,
      trim: true,
      match: [/^[A-Z]{3}$/, "Currency must be a 3-letter code such as GBP, USD or PKR."],
    },

    // Lets a barber retire a service without deleting it. Deleting would
    // break the history of past bookings that referenced it.
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// Speeds up "show me this barber's active services".
serviceSchema.index({ barber: 1, isActive: 1 });

// Stops a barber accidentally creating two services with the same name.
serviceSchema.index({ barber: 1, name: 1 }, { unique: true });

serviceSchema.methods.toPublicJSON = function () {
  // barber is normally a plain id, but a caller that did
  // .populate("barber") first gets a populated document there instead --
  // same populated-vs-not handling Booking.toJSONFor already does for its
  // own customer/barber refs. Without this, barberId would silently leak
  // the whole populated document to a caller expecting a plain id.
  const populatedBarber = this.barber && this.barber.name ? this.barber : null;

  return {
    id: this._id,
    barberId: populatedBarber ? populatedBarber._id : this.barber,
    name: this.name,
    description: this.description,
    durationMinutes: this.durationMinutes,
    priceMinor: this.priceMinor,
    currency: this.currency,
    isActive: this.isActive,
  };
};

module.exports = mongoose.model("Service", serviceSchema);
