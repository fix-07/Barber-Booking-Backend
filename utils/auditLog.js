const AuditLog = require("../models/AuditLog");

/**
 * Writes one audit entry. The ONLY thing that writes to the AuditLog
 * collection -- keeping it to one function is what makes the "never log a
 * secret" rule checkable in one place instead of at forty call sites.
 *
 * NEVER FAILS THE REQUEST IT IS LOGGING.
 * If the log write throws (database hiccup, validation slip), the admin's
 * actual action has already happened and must still return success. Losing
 * a log line is bad; telling an admin their deletion failed when it
 * succeeded is worse, because they will try again on a record that is
 * already gone. The error is printed server-side so the problem is still
 * visible to you.
 *
 * Call it AFTER the action succeeds, never before -- an entry saying
 * "deleted X" for a delete that then failed is worse than no entry.
 *
 * @param {object} req      the Express request, for req.user (the admin)
 * @param {object} entry    { action, resourceType, resourceId, summary }
 */
const recordAudit = async (req, { action, resourceType, resourceId = null, summary }) => {
  try {
    const admin = req.user;
    if (!admin) return; // Nothing to attribute it to; skip rather than guess.

    await AuditLog.create({
      admin: admin._id,
      adminName: admin.name,
      adminEmail: admin.email,
      action,
      resourceType,
      resourceId,
      summary: String(summary).slice(0, 300),
    });
  } catch (error) {
    console.error("Audit log write failed:", error.message);
  }
};

module.exports = { recordAudit };
