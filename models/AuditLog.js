const mongoose = require("mongoose");

/**
 * A record of an administrative action.
 *
 * WHY THIS EXISTS: every destructive admin action in this codebase --
 * deleting a client, deleting a barber, suspending an account, approving or
 * rejecting a barber application, wiping a payment record -- was previously
 * untraceable. The record simply changed or vanished with nothing saying
 * who did it or when. That is a real gap for a platform where more than one
 * person may eventually hold an admin account.
 *
 * WHAT IS DELIBERATELY NEVER STORED HERE:
 * passwords, password hashes, OTP codes, JWTs, API keys, connection
 * strings, or full request bodies. `summary` is written by the calling
 * controller as a short, human-readable sentence, never a dump of req.body
 * (which is exactly how credentials end up in logs by accident). See
 * utils/auditLog.js, which is the only thing that writes to this
 * collection.
 *
 * ADMIN IDENTITY IS SNAPSHOTTED, not just referenced: adminName/adminEmail
 * are copied in at write time, the same reasoning as
 * Booking.customerNameAtBooking. An audit trail that stops saying who did
 * something once that admin's account is deleted is not an audit trail.
 */
const auditLogSchema = new mongoose.Schema(
  {
    admin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    adminName: { type: String, required: true },
    adminEmail: { type: String, required: true },

    /**
     * What happened, as a stable machine-readable key. Kept as a free string
     * rather than an enum on purpose: a new admin action added later should
     * never fail to be logged because someone forgot to extend an enum
     * first. The cost of a typo'd action name is a slightly odd filter
     * entry; the cost of a silently unlogged deletion is much worse.
     */
    action: { type: String, required: true, index: true },

    /** "client" | "barber" | "booking" | "service" | "payment" | "review" | "settings" | "session" */
    resourceType: { type: String, required: true, index: true },

    /** The affected record's id, where there is a single one. */
    resourceId: { type: mongoose.Schema.Types.ObjectId, default: null },

    /**
     * A short sentence a human can read in the log list without opening
     * anything else: "Suspended client Sara Malik", "Deleted service Skin
     * fade". Written explicitly at each call site.
     */
    summary: { type: String, required: true, maxlength: 300 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// The list view is always "newest first", optionally filtered by action or
// resource type. This covers all three.
auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ resourceType: 1, createdAt: -1 });

auditLogSchema.methods.toAdminJSON = function () {
  return {
    id: this._id,
    adminId: this.admin,
    adminName: this.adminName,
    adminEmail: this.adminEmail,
    action: this.action,
    resourceType: this.resourceType,
    resourceId: this.resourceId,
    summary: this.summary,
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.model("AuditLog", auditLogSchema);
