const AuditLog = require("../models/AuditLog");
const { readPaging } = require("../utils/queryHelpers");

/**
 * GET /api/admin/audit-logs?resourceType=&action=&page=&limit=
 *
 * READ ONLY, deliberately. There is no endpoint to edit or delete an audit
 * entry, and there should not be: a log an admin can quietly rewrite is not
 * evidence of anything. Entries are only ever created, by
 * utils/auditLog.js, as a side effect of a real action.
 */
const listAuditLogs = async (req, res) => {
  const { page, limit, skip } = readPaging(req.query, { defaultLimit: 50, maxLimit: 200 });

  const filter = {};
  if (req.query.resourceType) filter.resourceType = String(req.query.resourceType).slice(0, 40);
  if (req.query.action) filter.action = String(req.query.action).slice(0, 60);

  const [logs, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    AuditLog.countDocuments(filter),
  ]);

  // The distinct lists power the filter dropdowns without the frontend
  // hardcoding a list of actions that would drift the moment a new one is
  // logged.
  const [resourceTypes, actions] = await Promise.all([
    AuditLog.distinct("resourceType"),
    AuditLog.distinct("action"),
  ]);

  res.status(200).json({
    logs: logs.map((log) => log.toAdminJSON()),
    resourceTypes: resourceTypes.sort(),
    actions: actions.sort(),
    page,
    limit,
    total,
  });
};

module.exports = { listAuditLogs };
