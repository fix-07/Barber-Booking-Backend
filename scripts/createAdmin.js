/**
 * Creates (or promotes) the first VEYRON admin account.
 *
 * WHY A SCRIPT, NOT A ROUTE:
 * routes/authRoutes.js deliberately blocks self-registration from setting
 * role to "admin" (see authController.js) -- there is no public way to
 * become an admin, on purpose. This script is the one intentional back
 * door, and it only runs locally, with direct database access, by whoever
 * already has that access. Never expose this as an HTTP endpoint.
 *
 * USAGE (run from anywhere -- it finds server/.env itself):
 *
 *   node server/scripts/createAdmin.js "Full Name" admin@example.com "a strong password"
 *
 *     Creates a brand-new user with role "admin". Fails with a clear
 *     message if that email is already registered -- use --promote instead.
 *
 *   node server/scripts/createAdmin.js --promote admin@example.com
 *
 *     Turns an EXISTING account (customer or barber) into an admin, in
 *     place, keeping its current password. Useful for promoting a real
 *     staff account rather than creating a separate login for them.
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const connectDB = require("../config/db");
const User = require("../models/User");

const usage = `
Usage:
  node server/scripts/createAdmin.js "Full Name" admin@example.com "a strong password"
  node server/scripts/createAdmin.js --promote admin@example.com
`;

const fail = (message) => {
  console.error(`\n${message}\n${usage}`);
  process.exit(1);
};

const run = async () => {
  const args = process.argv.slice(2);

  if (args.length === 0) fail("Missing arguments.");

  await connectDB();

  try {
    if (args[0] === "--promote") {
      const email = (args[1] || "").trim().toLowerCase();
      if (!email) fail("Missing email for --promote.");

      const user = await User.findOne({ email });
      if (!user) fail(`No account found with email "${email}".`);
      if (user.role === "admin") {
        console.log(`"${email}" is already an admin. Nothing to do.`);
        return;
      }

      const previousRole = user.role;
      user.role = "admin";
      await user.save();
      console.log(
        `Promoted "${user.name}" <${email}> from "${previousRole}" to "admin".`
      );
      return;
    }

    const [name, emailRaw, password] = args;
    if (!name || !emailRaw || !password) fail("Missing arguments.");

    const email = emailRaw.trim().toLowerCase();
    const existing = await User.findOne({ email });
    if (existing) {
      fail(
        `"${email}" is already registered as "${existing.role}". ` +
          `Use --promote to turn that account into an admin instead.`
      );
    }

    // acceptedPolicies is required on the schema; an admin account created
    // directly by whoever runs this script is exactly the "you, the
    // operator" case the policies are written for, not a customer who needs
    // to tick a box.
    const admin = new User({
      name,
      email,
      password,
      phone: "N/A",
      role: "admin",
      acceptedPolicies: true,
      acceptedPoliciesAt: new Date(),
    });
    await admin.save();

    console.log(`\nAdmin account created: "${name}" <${email}>.`);
    console.log("Log in at /admin/login with this email and the password you just set.\n");
  } finally {
    await mongoose.connection.close();
  }
};

run().catch((error) => {
  console.error("\nCould not create/promote admin:", error.message);
  process.exit(1);
});
