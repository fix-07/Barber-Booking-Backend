// Load .env FIRST, before anything reads process.env.
require("dotenv").config();

const express = require("express");

const validateEnv = require("./utils/validateEnv");
const connectDB = require("./config/db");

const securityHeaders = require("./middleware/securityHeaders");
const corsMiddleware = require("./middleware/cors");
const sanitizeRequest = require("./middleware/sanitize");
const { generalLimiter } = require("./middleware/rateLimit");
const { notFound, errorHandler } = require("./middleware/errorHandler");
const { requireAuth, requireRole } = require("./middleware/auth");

const authRoutes = require("./routes/authRoutes");
const barberRoutes = require("./routes/barberRoutes");
const serviceRoutes = require("./routes/serviceRoutes");
const bookingRoutes = require("./routes/bookingRoutes");
const settingsRoutes = require("./routes/settingsRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const geocodeRoutes = require("./routes/geocodeRoutes");
const reviewRoutes = require("./routes/reviewRoutes");

const adminBookingRoutes = require("./routes/adminBookingRoutes");
const adminClientRoutes = require("./routes/adminClientRoutes");
const adminBarberRoutes = require("./routes/adminBarberRoutes");
const adminBarberApprovalRoutes = require("./routes/adminBarberApprovalRoutes");
const adminServiceRoutes = require("./routes/adminServiceRoutes");
const adminReviewRoutes = require("./routes/adminReviewRoutes");
const adminAnalyticsRoutes = require("./routes/adminAnalyticsRoutes");
const adminSettingsRoutes = require("./routes/adminSettingsRoutes");
const adminAuditLogRoutes = require("./routes/adminAuditLogRoutes");

// Refuse to start with a missing or weak JWT_SECRET / MONGO_URI.
validateEnv();

const app = express();

/**
 * MIDDLEWARE ORDER MATTERS. Express runs these top to bottom for every
 * request, so each step below assumes the ones above it already ran.
 */

// 1. Do not advertise that this is an Express app.
app.disable("x-powered-by");

// 2. req.ip should reflect the real visitor, not the proxy, once deployed.
//    Most hosts (Render, Railway, Heroku, Nginx) sit in front of your app.
//    Without this the rate limiter would see every visitor as one IP.
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

// 3. Security headers on every response.
app.use(securityHeaders);

// 4. Our own CORS rules (we do not use the "cors" package).
app.use(corsMiddleware);

// 5. Parse JSON bodies. The size limit stops someone sending a 50 MB body
//    to exhaust the server's memory.
app.use(express.json({ limit: "10kb" }));

// 6. Strip MongoDB operators such as $ne from user input.
app.use(sanitizeRequest);

// 7. A gentle overall request limit.
app.use(generalLimiter);

/**
 * ROUTES
 */
app.use("/api/auth", authRoutes);
app.use("/api/barbers", barberRoutes);
app.use("/api/services", serviceRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/geocode", geocodeRoutes);
app.use("/api/reviews", reviewRoutes);

/**
 * ADMIN ROUTES.
 *
 * requireAuth + requireRole("admin") are applied ONCE here, to the whole
 * mount, rather than repeated inside each admin route file. Every route in
 * every admin router is admin-only with no exceptions (unlike
 * bookingRoutes.js, say, which genuinely mixes public/customer/barber
 * routes in one file) -- applying the guard at the mount point means a new
 * route added later to any of these files is admin-gated automatically,
 * with no way to forget it.
 */
const adminOnly = [requireAuth, requireRole("admin")];
app.use("/api/admin/bookings", adminOnly, adminBookingRoutes);
app.use("/api/admin/clients", adminOnly, adminClientRoutes);
app.use("/api/admin/barbers", adminOnly, adminBarberRoutes);
app.use("/api/admin/barber-approvals", adminOnly, adminBarberApprovalRoutes);
app.use("/api/admin/services", adminOnly, adminServiceRoutes);
app.use("/api/admin/reviews", adminOnly, adminReviewRoutes);
app.use("/api/admin/analytics", adminOnly, adminAnalyticsRoutes);
app.use("/api/admin/settings", adminOnly, adminSettingsRoutes);
app.use("/api/admin/audit-logs", adminOnly, adminAuditLogRoutes);

// A simple health check. Returns nothing sensitive: no versions, no
// environment details, no database information.
app.get("/api/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

/**
 * ERROR HANDLING - must come after all routes.
 */
app.use(notFound);
app.use(errorHandler);

/**
 * START
 */
const PORT = process.env.PORT || 5000;

const start = async () => {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  });
};

// Exported so tests/integration.test.js can bind this exact app to an
// ephemeral port with supertest, with its own database connection --
// require.main check means `node server.js` still starts for real exactly
// as before; only `require("./server")` (what a test does) skips it.
module.exports = app;

if (require.main === module) {
  start();
}
