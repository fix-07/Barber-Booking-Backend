/**
 * Sending mail.
 *
 * ==========================================================================
 *  WHY THIS IS AN INTERFACE AND NOT JUST ONE PROVIDER CALL
 * ==========================================================================
 *
 * This picks a transport at startup based on what is actually configured,
 * in this order:
 *
 *   Resend configured  -> really sends, via the Resend API. Preferred:
 *                         it is what this project is meant to run on.
 *   Not Resend, but
 *     SMTP configured   -> really sends, via nodemailer (e.g. Gmail SMTP).
 *                         Kept as a fallback for anyone who has SMTP
 *                         credentials but not a Resend account.
 *   Neither configured,
 *     development       -> writes the message to the SERVER terminal so
 *                         the flow is genuinely testable end to end.
 *   Neither configured,
 *     production        -> refuses loudly. A silent no-op in production
 *                         would mean people never receive their code and
 *                         nothing anywhere says why.
 *
 * To switch on Resend, add these to server/.env and restart:
 *
 *   RESEND_API_KEY=re_...
 *   MAIL_FROM="VEYRON <no-reply@yourdomain.com>"
 *
 * Get a key at https://resend.com (free tier available). One real
 * constraint of Resend specifically, not of this app: on a free/unverified
 * account it can only deliver to the email address you signed up with,
 * until you verify a sending domain at
 * https://resend.com/domains. Verified codes will not reach OTHER
 * people's inboxes until that domain verification is done -- this is
 * Resend's own anti-abuse rule, not a bug here.
 *
 * To switch on SMTP instead (or as a fallback), add:
 *
 *   SMTP_HOST=smtp.yourprovider.com
 *   SMTP_PORT=587
 *   SMTP_USER=...
 *   SMTP_PASS=...
 *   MAIL_FROM="VEYRON <no-reply@yourdomain.com>"
 *
 * No credential is ever read anywhere but here, and none is ever sent to
 * the browser.
 *
 * ==========================================================================
 *  THE CONSOLE TRANSPORT IS DEVELOPMENT ONLY, DELIBERATELY
 * ==========================================================================
 *
 * A verification code printed to a log is a real credential sitting in
 * plain text. That is acceptable on your own machine while building; it is
 * not acceptable on a server whose logs are retained, shipped to a log
 * service, or readable by anyone with access. So this transport refuses to
 * run when NODE_ENV is "production", and the code never travels anywhere
 * else -- not in an API response, not to the browser console, not into an
 * audit log entry.
 */

const isProduction = () => process.env.NODE_ENV === "production";

/**
 * Test-only capture hook. See the NODE_ENV === "test" branch of sendMail
 * below for what this is for and why it exists instead of either printing
 * the code or brute-forcing it back out of its hash.
 */
let testMailListener = null;
const onTestMail = (listener) => {
  testMailListener = listener;
};

const resendIsConfigured = () => Boolean(process.env.RESEND_API_KEY);

const smtpIsConfigured = () =>
  Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

// RESEND_FROM_EMAIL is the name asked for explicitly wherever this project
// is specced against Resend; MAIL_FROM is the older, provider-agnostic
// name already used for the SMTP fallback. Both are honoured so neither a
// Resend-shaped .env nor an SMTP-shaped one has to be rewritten.
const mailFrom = () =>
  process.env.RESEND_FROM_EMAIL ||
  process.env.MAIL_FROM ||
  "VEYRON <no-reply@veyron.local>";

/**
 * Both clients are lazily built and cached, so a project with only ONE of
 * the two packages' credentials configured never even touches the other
 * package -- neither has to be installed for the other transport to work.
 */
let cachedResendClient = null;

const getResendClient = () => {
  if (cachedResendClient) return cachedResendClient;
  // eslint-disable-next-line global-require
  const { Resend } = require("resend");
  cachedResendClient = new Resend(process.env.RESEND_API_KEY);
  return cachedResendClient;
};

let cachedSmtpTransport = null;

const getSmtpTransport = () => {
  if (cachedSmtpTransport) return cachedSmtpTransport;
  // eslint-disable-next-line global-require
  const nodemailer = require("nodemailer");

  cachedSmtpTransport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    // Port 465 is implicit TLS; everything else upgrades with STARTTLS.
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  return cachedSmtpTransport;
};

/**
 * Sends one message.
 *
 * Resolves with { delivered: true, transport: "resend" | "smtp" } when a
 * real provider accepted it, and { delivered: false, transport: "console" }
 * in development with neither configured. Throws if it genuinely could not
 * send, so the caller can decide what to tell the user -- see
 * authController, which deliberately does NOT leak "that address does not
 * exist" back to the browser.
 */
const sendMail = async ({ to, subject, text }) => {
  /**
   * TEST MODE IS CHECKED FIRST, BEFORE either provider check.
   *
   * This order matters and once genuinely broke: server/.env carries real
   * provider credentials for actual use, and that SAME .env file is loaded
   * by the Jest suite (tests/integration.test.js reads it directly). With
   * a provider branch checked first, every test run would try to send
   * real mail through the real account to fake "jest-cust-...@example.com"
   * addresses -- slow, network-dependent, and a real risk of the sending
   * account being flagged for repeatedly mailing nonexistent domains.
   * Checking NODE_ENV first means real credentials can sit in .env
   * unconditionally without the test suite ever touching them.
   *
   * Accepts the message, sends nothing, and hands it to whatever the test
   * suite has registered with onTestMail (below) instead. Printing the
   * code (the development transport's behaviour) would put a real
   * credential into the test runner's stdout and into whatever CI
   * captures that output to -- the same "codes sitting in plain text in a
   * log" problem the production guard below exists to prevent.
   * Brute-forcing the bcrypt hash the code is stored as is not a real
   * alternative either: at up to 1,000,000 candidates and a deliberately
   * slow hash, that is hours of CPU per test, not a test suite.
   *
   * So a test that needs the code registers a listener and reads the
   * value this function was actually about to send -- the same message a
   * real provider would receive, just captured instead of transmitted.
   */
  if (process.env.NODE_ENV === "test") {
    if (typeof testMailListener === "function") testMailListener({ to, subject, text });
    return { delivered: false, transport: "test" };
  }

  if (resendIsConfigured()) {
    const { error } = await getResendClient().emails.send({
      from: mailFrom(),
      to,
      subject,
      text,
    });

    // The Resend SDK reports a failed send by returning an `error` object
    // rather than throwing -- if that goes unchecked, a rejected send
    // looks identical to a successful one to the rest of the app.
    if (error) {
      throw new Error(`Resend could not send the message: ${error.message || error.name || "unknown error"}`);
    }

    return { delivered: true, transport: "resend" };
  }

  if (smtpIsConfigured()) {
    await getSmtpTransport().sendMail({
      from: mailFrom(),
      to,
      subject,
      text,
    });
    return { delivered: true, transport: "smtp" };
  }

  if (isProduction()) {
    throw new Error(
      "No mail transport is configured. Set RESEND_API_KEY, or SMTP_HOST/SMTP_USER/SMTP_PASS."
    );
  }

  // Development only. See the header comment for why this is fenced off.
  console.log(
    [
      "",
      "──────────── MAIL (development transport) ────────────",
      ` To:      ${to}`,
      ` Subject: ${subject}`,
      "",
      text,
      "──────────────────────────────────────────────────────",
      " Not sent anywhere. Configure RESEND_API_KEY (or SMTP_*) in server/.env to send for real.",
      "",
    ].join("\n")
  );

  return { delivered: false, transport: "console" };
};

module.exports = { sendMail, resendIsConfigured, smtpIsConfigured, onTestMail };
