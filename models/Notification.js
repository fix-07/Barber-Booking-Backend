const mongoose = require("mongoose");

/**
 * An in-app notification for one user.
 *
 * DELIBERATELY SEPARATE FROM EMAIL. An email and a notification bell entry
 * are sent for the same real event, through the same call in
 * services/notificationService.js, but they are two different documents
 * with two different lifecycles: an email is fire-and-forget, this is
 * something the person reads, marks read, and can delete later.
 */
const notificationSchema = new mongoose.Schema(
  {
    // Who this belongs to. Every query in notificationController.js
    // filters on this from the verified session -- never from anything
    // the request claims -- so one user can never see another's.
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    type: {
      type: String,
      required: true,
      enum: [
        "booking_created",
        "booking_confirmed",
        "booking_rejected",
        "booking_cancelled",
        "booking_completed",
        "booking_reminder",
        "barber_application_received",
        "barber_approved",
        "barber_rejected",
        "barber_suspended",
        "barber_reactivated",
        "account_verified",
        "password_reset",
        "admin_announcement",
      ],
    },

    title: { type: String, required: true, trim: true, maxlength: 140 },
    message: { type: String, required: true, trim: true, maxlength: 500 },

    // Where clicking the notification should take you, e.g.
    // "/my-bookings" or "/admin/barber-approvals". Optional -- an
    // announcement might not link anywhere.
    link: { type: String, trim: true, maxlength: 200, default: "" },

    isRead: { type: Boolean, default: false },
    readAt: { type: Date, default: null },

    /**
     * What happened to the EMAIL half of this event -- the in-app row
     * above always saves regardless, but the email is a separate network
     * call that can fail on its own (bad address, provider outage, no
     * transport configured). "A booking still gets created even if the
     * email does not" is a hard requirement (see
     * services/notificationService.js), so this is where that failure
     * becomes visible to an admin instead of vanishing into a log no one
     * is watching.
     */
    emailStatus: {
      type: String,
      enum: ["sent", "failed", "skipped"],
      default: "skipped",
    },
    emailError: { type: String, default: "" },
  },
  { timestamps: true }
);

// The notification bell's own query: my unread, newest first.
notificationSchema.index({ user: 1, isRead: 1, createdAt: -1 });

notificationSchema.methods.toPublicJSON = function () {
  return {
    id: this._id,
    type: this.type,
    title: this.title,
    message: this.message,
    link: this.link || undefined,
    isRead: this.isRead,
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.model("Notification", notificationSchema);
