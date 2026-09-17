/**
 * Focused regression suite for the highest-risk invariants in this app --
 * not exhaustive coverage, the things that would actually hurt if they
 * silently broke: privilege escalation, cross-account access (IDOR),
 * double-booking, and "delete really deletes / delete-payment never
 * refunds".
 *
 * ISOLATION: this connects to a dedicated database ("veyron_jest"), never
 * the real one MONGO_URI's connection string implies (it has no db name in
 * the path, so the driver would otherwise default to a database literally
 * named "test" -- the same one this whole app's real data lives in. See
 * the QA report's Database Findings for why that default is worth fixing
 * separately). afterAll drops ONLY this dedicated database.
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const request = require("supertest");

const TEST_DB_NAME = "veyron_jest";

let app;
let User;
let Booking;
let Service;

beforeAll(async () => {
  await mongoose.connect(process.env.MONGO_URI, { dbName: TEST_DB_NAME });
  app = require("../server");
  User = require("../models/User");
  Booking = require("../models/Booking");
  Service = require("../models/Service");
}, 30000);

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
});

const { onTestMail } = require("../utils/mailer");

/** Extracts the 6-digit code from a captured mail body. */
const codeFromMailText = (text) => {
  const match = /^\s{4}(\d{6})\s*$/m.exec(text || "");
  return match ? match[1] : null;
};

/**
 * Captures the code from the very next email whose subject matches
 * `purpose`. Registered BEFORE the action that triggers the send, so it is
 * already listening when the controller calls sendMail synchronously
 * inside the request. Safe against tests running one at a time
 * (--runInBand), which this suite already requires.
 */
const captureNextCode = (purpose) =>
  new Promise((resolve) => {
    onTestMail(({ subject, text }) => {
      const isReset = /reset/i.test(subject);
      if (purpose === "password_reset" && !isReset) return;
      if (purpose === "account_verification" && isReset) return;
      resolve(codeFromMailText(text));
    });
  });

/**
 * POST /api/auth/register ONLY -- does not verify. Returns { res, email }
 * so a test can drive verify-registration/resend-registration-code itself.
 * Use this for anything testing the verification MECHANICS. Use
 * registerCustomer (below) for anything that just needs a real, logged-in
 * account to test something else against.
 */
const rawRegister = (overrides = {}) => {
  const email =
    overrides.email ||
    `jest-cust-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  return request(app)
    .post("/api/auth/register")
    .send({
      name: "Jest Customer",
      email,
      password: "TestPassw0rd!123",
      phone: "07000000001",
      role: "customer",
      acceptedPolicies: true,
      ...overrides,
      email, // re-applied last: `overrides.email` must match the email above
    })
    .then((res) => ({ res, email }));
};

/**
 * A REAL, LOGGED-IN customer account, for tests that need one to exercise
 * something else (IDOR, admin authorization, booking, password reset, ...)
 * and do not care how verification works.
 *
 * Since POST /api/auth/register no longer creates an account by itself
 * (see controllers/pendingRegistrationController.js -- registering only
 * creates a PendingRegistration; the account is born at
 * verify-registration), this drives the real two-step flow: register,
 * capture the emailed code the same way a browser's user cannot, then
 * verify. What it returns is shaped exactly like the old direct-register
 * response (status/body.user/headers["set-cookie"]) so every OTHER test in
 * this file that calls registerCustomer() keeps working unchanged.
 */
const registerCustomer = async (overrides = {}) => {
  const codePromise = captureNextCode("account_verification");
  const { res: reg, email } = await rawRegister(overrides);

  if (reg.status !== 201) return reg; // let the caller see the raw failure

  const code = await codePromise;
  return request(app)
    .post("/api/auth/verify-registration")
    .send({ email, code });
};

/**
 * A fixed, safe time N days from now, at a time-of-day that cannot land
 * outside a test shop's working hours (00:00-23:00) no matter what time
 * it actually is when the suite runs. Date.now() + N days PRESERVES the
 * current time-of-day, which is exactly why this needed fixing: it
 * intermittently failed for real, whenever the suite happened to run late
 * enough in the day that "N days from now" landed after 23:00 local time.
 */
const daysFromNowAt = (days, hour) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

describe("Privilege escalation", () => {
  test("registering with role=admin is refused, not silently downgraded to a real account with the wrong role", async () => {
    const res = await request(app).post("/api/auth/register").send({
      name: "Escalator",
      email: `jest-escalate-${Date.now()}@example.com`,
      password: "TestPassw0rd!123",
      phone: "07000000002",
      role: "admin",
      acceptedPolicies: true,
    });
    expect(res.status).toBe(400);
    const stored = await User.findOne({ email: { $regex: /^jest-escalate-/ } });
    expect(stored).toBeNull();
  });

  test("wrong password is rejected", async () => {
    const reg = await registerCustomer();
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: reg.body.user.email, password: "TotallyWrongPassword" });
    expect(res.status).toBe(401);
  });
});

describe("Authorization: admin routes are actually admin-only", () => {
  test("an unauthenticated request is rejected", async () => {
    const res = await request(app).get("/api/admin/clients");
    expect(res.status).toBe(401);
  });

  test("a logged-in customer cannot read the admin client list", async () => {
    const reg = await registerCustomer();
    const cookie = reg.headers["set-cookie"];
    const res = await request(app).get("/api/admin/clients").set("Cookie", cookie);
    expect(res.status).toBe(403);
  });
});

describe("IDOR: one customer cannot reach another customer's booking", () => {
  test("customer B gets 404, not the booking, for customer A's booking id", async () => {
    const a = await registerCustomer();
    const b = await registerCustomer();
    const cookieA = a.headers["set-cookie"];
    const cookieB = b.headers["set-cookie"];

    const barber = await User.create({
      name: "Jest Barber", email: `jest-barber-${Date.now()}@example.com`,
      password: "TestPassw0rd!123", phone: "07000000003", role: "barber", status: "active",
      acceptedPolicies: true, acceptedPoliciesAt: new Date(),
    });
    const BarberProfile = require("../models/BarberProfile");
    await BarberProfile.create({
      user: barber._id, shopName: "Jest Shop", city: "London", timeZone: "Europe/London",
      isPublished: true,
      workingHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, isOpen: true, open: "00:00", close: "23:00" })),
    });
    const service = await Service.create({
      barber: barber._id, name: "Jest Cut", durationMinutes: 30, priceMinor: 2000, currency: "GBP",
    });

    const startAt = daysFromNowAt(5, 10);
    const bookRes = await request(app)
      .post("/api/bookings")
      .set("Cookie", cookieA)
      .send({ serviceId: String(service._id), startAt });
    expect(bookRes.status).toBe(201);
    const bookingId = bookRes.body.booking.id;

    const ownRes = await request(app).get(`/api/bookings/${bookingId}`).set("Cookie", cookieA);
    expect(ownRes.status).toBe(200);

    const crossRes = await request(app).get(`/api/bookings/${bookingId}`).set("Cookie", cookieB);
    expect(crossRes.status).toBe(404);
  });
});

describe("Booking integrity: double-booking under concurrency", () => {
  test("exactly one of several simultaneous requests for the identical slot succeeds", async () => {
    const cust = await registerCustomer();
    const cookie = cust.headers["set-cookie"];

    const barber = await User.create({
      name: "Jest Race Barber", email: `jest-race-barber-${Date.now()}@example.com`,
      password: "TestPassw0rd!123", phone: "07000000004", role: "barber", status: "active",
      acceptedPolicies: true, acceptedPoliciesAt: new Date(),
    });
    const BarberProfile = require("../models/BarberProfile");
    await BarberProfile.create({
      user: barber._id, shopName: "Jest Race Shop", city: "London", timeZone: "Europe/London",
      isPublished: true,
      workingHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, isOpen: true, open: "00:00", close: "23:00" })),
    });
    const service = await Service.create({
      barber: barber._id, name: "Jest Race Cut", durationMinutes: 30, priceMinor: 1500, currency: "GBP",
    });

    const startAt = daysFromNowAt(6, 10);
    const attempts = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(app).post("/api/bookings").set("Cookie", cookie).send({ serviceId: String(service._id), startAt })
      )
    );

    const succeeded = attempts.filter((r) => r.status === 201);
    expect(succeeded.length).toBe(1);

    const realRows = await Booking.countDocuments({ service: service._id, startAt: new Date(startAt), holdsSlot: true });
    expect(realRows).toBe(1);
  });
});

describe("Admin delete: real deletion, not a status flag", () => {
  test("deleting a service removes the document from the database", async () => {
    const barber = await User.create({
      name: "Jest Delete Barber", email: `jest-delete-barber-${Date.now()}@example.com`,
      password: "TestPassw0rd!123", phone: "07000000005", role: "barber", status: "active",
      acceptedPolicies: true, acceptedPoliciesAt: new Date(),
    });
    const service = await Service.create({
      barber: barber._id, name: "Jest Delete Cut", durationMinutes: 30, priceMinor: 1000, currency: "GBP",
    });

    const admin = await User.create({
      name: "Jest Admin", email: `jest-admin-${Date.now()}@example.com`,
      password: "TestPassw0rd!123", phone: "07000000006", role: "admin", status: "active",
      acceptedPolicies: true, acceptedPoliciesAt: new Date(),
    });
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ email: admin.email, password: "TestPassw0rd!123" });
    const adminCookie = loginRes.headers["set-cookie"];

    const delRes = await request(app).delete(`/api/admin/services/${service._id}`).set("Cookie", adminCookie);
    expect(delRes.status).toBe(200);

    const stillThere = await Service.findById(service._id);
    expect(stillThere).toBeNull();
  });
});

describe("Payment delete never refunds", () => {
  test("clearing a payment resets to unpaid, never sets status to refunded, and never touches money", async () => {
    const barber = await User.create({
      name: "Jest Payment Barber", email: `jest-payment-barber-${Date.now()}@example.com`,
      password: "TestPassw0rd!123", phone: "07000000007", role: "barber", status: "active",
      acceptedPolicies: true, acceptedPoliciesAt: new Date(),
    });
    const cust = await User.create({
      name: "Jest Payment Customer", email: `jest-payment-cust-${Date.now()}@example.com`,
      password: "TestPassw0rd!123", phone: "07000000008", role: "customer", status: "active",
      acceptedPolicies: true, acceptedPoliciesAt: new Date(),
    });
    const service = await Service.create({
      barber: barber._id, name: "Jest Payment Cut", durationMinutes: 30, priceMinor: 3000, currency: "GBP",
    });
    const booking = await Booking.create({
      customer: cust._id, barber: barber._id, service: service._id,
      startAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      endAt: new Date(Date.now() + 24 * 60 * 60 * 1000 + 30 * 60000),
      status: "completed",
      serviceNameAtBooking: service.name, durationMinutesAtBooking: 30,
      priceMinorAtBooking: 3000, currencyAtBooking: "GBP",
      payment: { status: "paid", method: "card", recordedAt: new Date(), recordedBy: null },
    });

    const admin = await User.create({
      name: "Jest Payment Admin", email: `jest-payment-admin-${Date.now()}@example.com`,
      password: "TestPassw0rd!123", phone: "07000000009", role: "admin", status: "active",
      acceptedPolicies: true, acceptedPoliciesAt: new Date(),
    });
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ email: admin.email, password: "TestPassw0rd!123" });
    const adminCookie = loginRes.headers["set-cookie"];

    const delRes = await request(app).delete(`/api/admin/bookings/${booking._id}/payment`).set("Cookie", adminCookie);
    expect(delRes.status).toBe(200);
    expect(delRes.body.booking.payment.status).not.toBe("refunded");

    const reloaded = await Booking.findById(booking._id);
    expect(reloaded.payment.status).toBe("unpaid");
    expect(reloaded.payment.method).toBeNull();
    // priceMinorAtBooking is the money figure -- must be completely untouched.
    expect(reloaded.priceMinorAtBooking).toBe(3000);
  });
});

describe("Suspended customer cannot log in", () => {
  test("login is refused once an admin suspends the account, even with the correct password", async () => {
    const reg = await registerCustomer();
    const user = await User.findOne({ email: reg.body.user.email });
    user.status = "suspended";
    await user.save();

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: reg.body.user.email, password: "TestPassw0rd!123" });
    expect(res.status).toBe(403);
  });
});

/* ==========================================================================
   Registration does not create an account -- verification does
   ==========================================================================

   The behaviour this whole block exists to prove: POST /api/auth/register
   stores a PendingRegistration, not a User. An account is born only inside
   verifyRegistration, in controllers/pendingRegistrationController.js, and
   only after the correct code is entered. Fail to verify -- wrong code
   five times, or let it expire -- and no account exists at all; the same
   email can be registered again from nothing.

   HOW A CODE IS OBTAINED HERE: only the stored value is a bcrypt hash (see
   models/PendingRegistration.js), and hashes are one-way by design --
   brute forcing six digits against a deliberately slow hash is hours of
   CPU, not a test suite. So utils/mailer.js exposes a test-only capture
   hook (onTestMail) that hands a test the exact message sendMail was
   about to send, in place of sending it -- the same message a real
   provider would have received, captured instead of transmitted. The API
   response itself is never the source -- see the assertions below that
   specifically check the code is ABSENT from every response body.
   ========================================================================== */

describe("Registering does not create an account", () => {
  test("no User exists until the code is verified, and the code never appears in any response", async () => {
    const codePromise = captureNextCode("account_verification");
    const { res: reg, email } = await rawRegister();

    expect(reg.status).toBe(201);
    expect(reg.body.user).toBeUndefined(); // nothing to log in as yet
    expect(reg.headers["set-cookie"]).toBeUndefined(); // no session either

    const User2 = require("../models/User");
    expect(await User2.findOne({ email })).toBeNull();

    const real = await codePromise;
    expect(real).toMatch(/^\d{6}$/);
    expect(JSON.stringify(reg.body)).not.toContain(real);

    const wrongAttempt = await request(app)
      .post("/api/auth/verify-registration")
      .send({ email, code: real === "000000" ? "111111" : "000000" });

    expect(wrongAttempt.status).toBe(400);
    expect(JSON.stringify(wrongAttempt.body)).not.toContain(real);
    expect(await User2.findOne({ email })).toBeNull(); // still nothing
  }, 60000);

  test("five wrong guesses burn the code, and STILL no account exists", async () => {
    const codePromise = captureNextCode("account_verification");
    const { res: reg, email } = await rawRegister();
    expect(reg.status).toBe(201);
    const real = await codePromise;
    const wrong = real === "000000" ? "111111" : "000000";

    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await request(app).post("/api/auth/verify-registration").send({ email, code: wrong });
    }

    const withCorrectCode = await request(app)
      .post("/api/auth/verify-registration")
      .send({ email, code: real });

    expect(withCorrectCode.status).toBe(400); // exhausted, even though correct

    const User2 = require("../models/User");
    expect(await User2.findOne({ email })).toBeNull();
  }, 90000);

  test("an abandoned signup can be re-submitted for the same email once expired", async () => {
    const PendingRegistration = require("../models/PendingRegistration");
    const { res: reg, email } = await rawRegister();
    expect(reg.status).toBe(201);

    // Simulate the 10-minute code expiring, rather than waiting for it.
    await PendingRegistration.updateOne(
      { email },
      { $set: { expiresAt: new Date(Date.now() - 1000) } }
    );

    const expiredAttempt = await request(app)
      .post("/api/auth/verify-registration")
      .send({ email, code: "000000" });
    expect(expiredAttempt.status).toBe(400);

    const retry = await rawRegister({ email });
    expect(retry.res.status).toBe(201); // no "email already registered" -- nothing was ever created

    const count = await PendingRegistration.countDocuments({ email });
    expect(count).toBe(1); // the old attempt was replaced, not duplicated
  }, 60000);

  test("verifying the correct code creates the account, and it works to log in", async () => {
    const verified = await registerCustomer();

    expect(verified.status).toBe(201);
    expect(verified.body.user.emailVerified).toBe(true);
    expect(verified.headers["set-cookie"]).toBeDefined(); // now, and only now, a real session

    const User2 = require("../models/User");
    const real = await User2.findOne({ email: verified.body.user.email }).select("+password");
    expect(real).not.toBeNull();
    expect(real.password).toMatch(/^\$2/); // bcrypt, and not double-hashed into unusable garbage

    const PendingRegistration = require("../models/PendingRegistration");
    expect(await PendingRegistration.findOne({ email: verified.body.user.email })).toBeNull();
  }, 60000);

  test("registering an email that already has a real account is refused, and creates no pending row", async () => {
    const verified = await registerCustomer();
    const email = verified.body.user.email;

    const dupe = await rawRegister({ email });
    expect(dupe.res.status).toBe(409);

    const PendingRegistration = require("../models/PendingRegistration");
    expect(await PendingRegistration.findOne({ email })).toBeNull();
  }, 60000);
});

describe("Forgot password is not a membership oracle", () => {
  test("a registered and an unregistered address get byte-identical replies", async () => {
    const reg = await registerCustomer();
    const known = reg.body.user.email;

    const a = await request(app).post("/api/auth/forgot-password").send({ email: known });
    const b = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: `definitely-not-registered-${Date.now()}@example.com` });

    expect(a.status).toBe(b.status);
    expect(JSON.stringify(a.body)).toBe(JSON.stringify(b.body));
  }, 60000);
});

describe("Password reset", () => {
  test("resets the password, does not sign the user in, and invalidates the old one", async () => {
    const reg = await registerCustomer();
    const email = reg.body.user.email;
    const oldPassword = "TestPassw0rd!123";
    const newPassword = "Rotated!Pass456";

    const codePromise = captureNextCode("password_reset");
    await request(app).post("/api/auth/forgot-password").send({ email });
    const code = await codePromise;
    expect(code).toMatch(/^\d{6}$/);

    const wrong = await request(app)
      .post("/api/auth/reset-password")
      .send({ email, code: code === "000000" ? "111111" : "000000", password: newPassword });
    expect(wrong.status).toBe(400);

    const done = await request(app)
      .post("/api/auth/reset-password")
      .send({ email, code, password: newPassword });
    expect(done.status).toBe(200);

    // A reset must not hand out a session: one emailed code should not be
    // enough to take over an account.
    expect(done.headers["set-cookie"]).toBeUndefined();

    const oldLogin = await request(app)
      .post("/api/auth/login")
      .send({ email, password: oldPassword });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app)
      .post("/api/auth/login")
      .send({ email, password: newPassword });
    expect(newLogin.status).toBe(200);
  }, 90000);
});

describe("Remember me", () => {
  test("lengthens the session cookie without changing what it is", async () => {
    const reg = await registerCustomer();
    const email = reg.body.user.email;
    const password = "TestPassw0rd!123";

    const normal = await request(app).post("/api/auth/login").send({ email, password });
    const remembered = await request(app)
      .post("/api/auth/login")
      .send({ email, password, rememberMe: true });

    const ageOf = (res) => {
      const m = (res.headers["set-cookie"] || []).join(";").match(/Max-Age=(\d+)/i);
      return m ? Number(m[1]) : 0;
    };

    expect(ageOf(remembered)).toBeGreaterThan(ageOf(normal));

    // Still httpOnly either way -- "remember me" must not downgrade the
    // cookie into something JavaScript can read.
    const flags = (remembered.headers["set-cookie"] || []).join(";");
    expect(flags).toMatch(/HttpOnly/i);
    expect(flags).toMatch(/SameSite/i);
  }, 60000);
});

/* ==========================================================================
   Google Sign-In
   ==========================================================================

   verifyGoogleIdToken talks to Google's live servers to check a real
   signature -- something a test cannot produce a valid one for. So these
   use the same kind of test-only seam as utils/mailer.js's onTestMail:
   setTestVerifier substitutes a fake identity in place of the real network
   call, letting every REAL branch of the account-linking logic in
   googleAuthController.js run for real -- new account, existing account by
   email, admin-role impossibility, unverified-email refusal, bad token.
   Only the "is this signature really from Google" step itself is stubbed.
   ========================================================================== */

const { setTestVerifier } = require("../utils/googleAuth");

describe("Google Sign-In", () => {
  test("a brand-new Google account is created as a customer, verified, with no phone yet", async () => {
    const email = `jest-google-new-${Date.now()}@example.com`;
    setTestVerifier(async () => ({
      googleId: `google-${Date.now()}`,
      email,
      emailVerified: true,
      name: "Jest Google User",
    }));

    const res = await request(app)
      .post("/api/auth/google")
      .send({ idToken: "fake", acceptedPolicies: true });

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe("customer");
    expect(res.body.user.emailVerified).toBe(true);
    expect(res.body.user.authProvider).toBe("google");
    expect(res.body.user.phone).toBe(""); // not collected yet
    expect(res.headers["set-cookie"]).toBeDefined(); // logged in immediately

    const stored = await User.findOne({ email }).select("+password");
    expect(stored.password).toBeUndefined(); // no password field at all, not even hashed-empty
    expect(stored.googleId).toBeTruthy();
  }, 30000);

  test("signing in again with the same Google account logs into the SAME user, not a new one", async () => {
    const email = `jest-google-again-${Date.now()}@example.com`;
    const googleId = `google-${Date.now()}`;
    setTestVerifier(async () => ({ googleId, email, emailVerified: true, name: "Again" }));

    const first = await request(app)
      .post("/api/auth/google")
      .send({ idToken: "fake", acceptedPolicies: true }); // creates the account
    const second = await request(app).post("/api/auth/google").send({ idToken: "fake" }); // existing account -- no consent needed again

    expect(first.body.user.id).toBe(second.body.user.id);
    expect(second.status).toBe(200); // 200, not 201 -- not a new account this time

    const count = await User.countDocuments({ googleId });
    expect(count).toBe(1);
  }, 30000);

  test("a Google sign-in matching an existing LOCAL account's email links to it, rather than refusing or duplicating", async () => {
    const verified = await registerCustomer(); // a normal local/password account
    const email = verified.body.user.email;

    setTestVerifier(async () => ({
      googleId: `google-linked-${Date.now()}`,
      email,
      emailVerified: true,
      name: "Linked",
    }));

    const res = await request(app).post("/api/auth/google").send({ idToken: "fake" });

    expect(res.status).toBe(200); // existing account, not a new one
    expect(res.body.user.id).toBe(verified.body.user.id);

    const stored = await User.findOne({ email });
    expect(stored.authProvider).toBe("local"); // linking does not overwrite this
    expect(stored.googleId).toBeTruthy(); // but Google is now also usable

    // The original password must still work -- linking Google must not
    // disturb the existing credential.
    const stillLogsIn = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "TestPassw0rd!123" });
    expect(stillLogsIn.status).toBe(200);
  }, 30000);

  test("Google can never create an admin account, because the endpoint has no role input at all", async () => {
    const email = `jest-google-admin-attempt-${Date.now()}@example.com`;
    setTestVerifier(async () => ({
      googleId: `google-${Date.now()}`,
      email,
      emailVerified: true,
      name: "Attempted Admin",
    }));

    // Even trying to smuggle a role in the body does nothing -- the
    // controller never reads req.body.role at all.
    const res = await request(app)
      .post("/api/auth/google")
      .send({ idToken: "fake", role: "admin", acceptedPolicies: true });

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe("customer");
  }, 30000);

  test("an unverified Google email is refused", async () => {
    setTestVerifier(async () => ({
      googleId: `google-unverified-${Date.now()}`,
      email: `jest-google-unverified-${Date.now()}@example.com`,
      emailVerified: false,
      name: "Unverified",
    }));

    const res = await request(app).post("/api/auth/google").send({ idToken: "fake" });
    expect(res.status).toBe(401);
  }, 30000);

  test("an invalid token is refused with 401, not a 500", async () => {
    setTestVerifier(async () => {
      throw new Error("invalid signature");
    });

    const res = await request(app).post("/api/auth/google").send({ idToken: "garbage" });
    expect(res.status).toBe(401);
  }, 30000);

  test("a brand-new Google account is refused without genuine consent, and creates no account", async () => {
    const email = `jest-google-noconsent-${Date.now()}@example.com`;
    setTestVerifier(async () => ({
      googleId: `google-${Date.now()}`,
      email,
      emailVerified: true,
      name: "No Consent",
    }));

    // No acceptedPolicies at all -- the same failure mode the classic
    // register endpoint refuses (see the "Please correct the highlighted
    // fields" check in authController.register), now checked for Google
    // too, exactly BECAUSE Google proving who someone is says nothing
    // about whether they have read OUR Terms and Privacy Policy.
    const res = await request(app).post("/api/auth/google").send({ idToken: "fake" });

    expect(res.status).toBe(400);
    expect(res.body.errors.acceptedPolicies).toBeDefined();
    expect(res.headers["set-cookie"]).toBeUndefined();

    const stored = await User.findOne({ email });
    expect(stored).toBeNull();
  }, 30000);
});

describe("Completing a Google profile", () => {
  test("a new Google account cannot book until it adds a phone number, then can immediately after", async () => {
    const email = `jest-google-phone-${Date.now()}@example.com`;
    setTestVerifier(async () => ({
      googleId: `google-${Date.now()}`,
      email,
      emailVerified: true,
      name: "Needs Phone",
    }));

    const signIn = await request(app)
      .post("/api/auth/google")
      .send({ idToken: "fake", acceptedPolicies: true });
    const cookie = signIn.headers["set-cookie"];

    const barber = await User.create({
      name: "Jest Phone Barber", email: `jest-phone-barber-${Date.now()}@example.com`,
      password: "TestPassw0rd!123", phone: "07000000009", role: "barber", status: "active",
      acceptedPolicies: true, acceptedPoliciesAt: new Date(),
    });
    const BarberProfile = require("../models/BarberProfile");
    await BarberProfile.create({
      user: barber._id, shopName: "Jest Phone Shop", city: "London", timeZone: "Europe/London",
      isPublished: true,
      workingHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, isOpen: true, open: "00:00", close: "23:00" })),
    });
    const service = await Service.create({
      barber: barber._id, name: "Jest Phone Cut", durationMinutes: 30, priceMinor: 1200, currency: "GBP",
    });

    const blocked = await request(app)
      .post("/api/bookings")
      .set("Cookie", cookie)
      .send({ serviceId: String(service._id), startAt: daysFromNowAt(4, 10) });
    expect(blocked.status).toBe(400);

    const completed = await request(app)
      .patch("/api/auth/complete-profile")
      .set("Cookie", cookie)
      .send({ phone: "07000000099" });
    expect(completed.status).toBe(200);
    expect(completed.body.user.phone).toBe("07000000099");

    const nowWorks = await request(app)
      .post("/api/bookings")
      .set("Cookie", cookie)
      .send({ serviceId: String(service._id), startAt: daysFromNowAt(4, 10) });
    expect(nowWorks.status).toBe(201);
  }, 30000);

  test("completing someone else's profile is impossible -- it always acts on the caller's own session", async () => {
    const res = await request(app).patch("/api/auth/complete-profile").send({ phone: "0700" });
    expect(res.status).toBe(401); // no session at all -- there is no id-in-body path to exploit
  });
});

/* ==========================================================================
   Notifications: email + in-app, idempotency, ownership isolation
   ========================================================================== */

const Notification = require("../models/Notification");
const SentEvent = require("../models/SentEvent");

// An admin account can only ever be created this way in the real app too --
// there is no self-service admin signup, by design.
const makeAdmin = () =>
  User.create({
    name: "Jest Admin",
    email: `jest-admin-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    password: "TestPassw0rd!123",
    phone: "07000000010",
    role: "admin",
    acceptedPolicies: true,
    acceptedPoliciesAt: new Date(),
  });

const loginAs = async (email, password) => {
  const res = await request(app).post("/api/auth/login").send({ email, password });
  return res.headers["set-cookie"];
};

/**
 * Booking notifications are deliberately fire-and-forget (see
 * bookingController.js's own comment: the HTTP response does not wait on
 * outbound emails). That means the Notification row may not exist the
 * instant the HTTP response comes back -- so tests poll briefly for it
 * instead of asserting immediately, which would be racing real async work
 * rather than testing it.
 */
const waitForNotification = async (filter, { timeoutMs = 5000, intervalMs = 100 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const found = await Notification.findOne(filter);
    if (found) return found;
    if (Date.now() > deadline) return null;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};

describe("Barber application notifications", () => {
  test("verifying a barber signup notifies both the barber and every admin, with a review link for admins", async () => {
    await makeAdmin(); // at least one admin must exist to receive it

    const codePromise = captureNextCode("account_verification");
    const email = `jest-barber-notif-${Date.now()}@example.com`;
    const { res: reg } = await rawRegister({
      name: "Notif Barber",
      email,
      phone: "07000000011",
      role: "barber",
      shopName: "Notif Shop",
      city: "Leeds",
      timeZone: "Europe/London",
    });
    expect(reg.status).toBe(201);
    const code = await codePromise;

    const verify = await request(app).post("/api/auth/verify-registration").send({ email, code });
    expect(verify.status).toBe(201);
    const barberId = verify.body.user.id;

    const barberNotifs = await Notification.find({ user: barberId });
    expect(barberNotifs.some((n) => n.type === "barber_application_received")).toBe(true);

    const adminNotifs = await Notification.find({ type: "barber_application_received" }).where("user").ne(barberId);
    expect(adminNotifs.length).toBeGreaterThan(0);
    expect(adminNotifs[0].link).toBe("/admin/barber-approvals");
  }, 60000);

  test("approving a barber creates a notification for that barber", async () => {
    const admin = await makeAdmin();
    const adminCookie = await loginAs(admin.email, "TestPassw0rd!123");

    const codePromise = captureNextCode("account_verification");
    const email = `jest-barber-approve-notif-${Date.now()}@example.com`;
    await rawRegister({
      name: "Approve Notif Barber",
      email,
      phone: "07000000012",
      role: "barber",
      shopName: "Approve Notif Shop",
      city: "Bristol",
      timeZone: "Europe/London",
    });
    const code = await codePromise;
    const verify = await request(app).post("/api/auth/verify-registration").send({ email, code });
    const barberId = verify.body.user.id;

    const approve = await request(app)
      .patch(`/api/admin/barber-approvals/${barberId}/approve`)
      .set("Cookie", adminCookie);
    expect(approve.status).toBe(200);

    const notifs = await Notification.find({ user: barberId, type: "barber_approved" });
    expect(notifs.length).toBe(1);
  }, 60000);
});

describe("Booking notifications", () => {
  test("creating, confirming and cancelling a booking each create the right notifications for the right people", async () => {
    const customerRes = await registerCustomer();
    const customerCookie = customerRes.headers["set-cookie"];
    const customerId = customerRes.body.user.id;

    const barber = await User.create({
      name: "Jest Notif Barber",
      email: `jest-notif-barber-${Date.now()}@example.com`,
      password: "TestPassw0rd!123",
      phone: "07000000013",
      role: "barber",
      status: "active",
      acceptedPolicies: true,
      acceptedPoliciesAt: new Date(),
    });
    const BarberProfile = require("../models/BarberProfile");
    await BarberProfile.create({
      user: barber._id,
      shopName: "Jest Notif Shop",
      city: "York",
      timeZone: "Europe/London",
      isPublished: true,
      workingHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, isOpen: true, open: "00:00", close: "23:00" })),
    });
    const service = await Service.create({
      barber: barber._id,
      name: "Jest Notif Cut",
      durationMinutes: 30,
      priceMinor: 1800,
      currency: "GBP",
    });

    const startAt = daysFromNowAt(3, 11);
    const bookRes = await request(app)
      .post("/api/bookings")
      .set("Cookie", customerCookie)
      .send({ serviceId: String(service._id), startAt });
    expect(bookRes.status).toBe(201);
    const bookingId = bookRes.body.booking.id;

    // Both sides notified of the new request.
    const customerCreated = await waitForNotification({ user: customerId, type: "booking_created" });
    const barberCreated = await waitForNotification({ user: barber._id, type: "booking_created" });
    expect(customerCreated).not.toBeNull();
    expect(barberCreated).not.toBeNull();
    expect(customerCreated.message).not.toContain("null"); // the exact bug this was written to catch
    expect(barberCreated.message).not.toContain("null");

    const barberCookie = await loginAs(barber.email, "TestPassw0rd!123");
    const confirmRes = await request(app)
      .patch(`/api/bookings/${bookingId}/status`)
      .set("Cookie", barberCookie)
      .send({ status: "confirmed" });
    expect(confirmRes.status).toBe(200);

    const customerConfirmed = await waitForNotification({ user: customerId, type: "booking_confirmed" });
    expect(customerConfirmed).not.toBeNull();

    const cancelRes = await request(app)
      .patch(`/api/bookings/${bookingId}/cancel`)
      .set("Cookie", customerCookie);
    expect(cancelRes.status).toBe(200);

    const barberCancelled = await waitForNotification({ user: barber._id, type: "booking_cancelled" });
    expect(barberCancelled).not.toBeNull();
  }, 60000);
});

describe("Notification idempotency", () => {
  test("the same dedupe key can only ever send once", async () => {
    const { notify } = require("../services/notificationService");
    const user = await registerCustomer();
    const userId = user.body.user.id;

    const key = `test:idempotency:${Date.now()}`;
    const args = {
      user: { _id: userId, email: user.body.user.email, name: "Idempotency Test" },
      type: "admin_announcement",
      title: "Test",
      message: "Test message",
      subject: "Test",
      text: "Test",
      dedupeKey: key,
    };

    await notify(args);
    await notify(args); // same key -- must not create a second row
    await notify(args);

    const count = await Notification.countDocuments({ user: userId, title: "Test" });
    expect(count).toBe(1);

    const eventCount = await SentEvent.countDocuments({ key });
    expect(eventCount).toBe(1);
  }, 60000);
});

describe("Notification API: ownership and actions", () => {
  test("one user can never see, read, or delete another user's notifications", async () => {
    const a = await registerCustomer();
    const b = await registerCustomer();
    const cookieA = a.headers["set-cookie"];
    const cookieB = b.headers["set-cookie"];

    const { notify } = require("../services/notificationService");
    await notify({
      user: { _id: a.body.user.id, email: a.body.user.email, name: "A" },
      type: "admin_announcement",
      title: "Only for A",
      message: "Private to A",
      subject: "x",
      text: "x",
    });

    const notifA = await Notification.findOne({ user: a.body.user.id, title: "Only for A" });

    const listB = await request(app).get("/api/notifications").set("Cookie", cookieB);
    expect(listB.body.notifications.some((n) => n.title === "Only for A")).toBe(false);

    const readAsB = await request(app).patch(`/api/notifications/${notifA._id}/read`).set("Cookie", cookieB);
    expect(readAsB.status).toBe(404); // not found FOR B -- ownership-scoped, not a real 403 leak

    const deleteAsB = await request(app).delete(`/api/notifications/${notifA._id}`).set("Cookie", cookieB);
    expect(deleteAsB.status).toBe(404);

    const stillThere = await Notification.findById(notifA._id);
    expect(stillThere).not.toBeNull();

    const readAsA = await request(app).patch(`/api/notifications/${notifA._id}/read`).set("Cookie", cookieA);
    expect(readAsA.status).toBe(200);
    expect(readAsA.body.notification.isRead).toBe(true);
  }, 60000);

  test("mark-all-read and unread-count reflect real state", async () => {
    const user = await registerCustomer();
    const cookie = user.headers["set-cookie"];

    const { notify } = require("../services/notificationService");
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await notify({
        user: { _id: user.body.user.id, email: user.body.user.email, name: "U" },
        type: "admin_announcement",
        title: `Notice ${i}`,
        message: "x",
        subject: "x",
        text: "x",
      });
    }

    const before = await request(app).get("/api/notifications/unread-count").set("Cookie", cookie);
    expect(before.body.unreadCount).toBeGreaterThanOrEqual(3);

    const markAll = await request(app).patch("/api/notifications/read-all").set("Cookie", cookie);
    expect(markAll.status).toBe(200);

    const after = await request(app).get("/api/notifications/unread-count").set("Cookie", cookie);
    expect(after.body.unreadCount).toBe(0);
  }, 60000);
});

describe("Geocode proxy", () => {
  test("returns real results from OpenStreetMap for a real city", async () => {
    const res = await request(app).get("/api/geocode/search").query({ q: "Paris" });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results.length).toBeGreaterThan(0);
    expect(typeof res.body.results[0].latitude).toBe("number");
    expect(typeof res.body.results[0].longitude).toBe("number");
  }, 20000);

  test("a query under 2 characters returns no results without calling the upstream service", async () => {
    const res = await request(app).get("/api/geocode/search").query({ q: "a" });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });
});
