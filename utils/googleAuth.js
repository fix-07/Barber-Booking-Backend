/**
 * Verifying a Google Sign-In ID token.
 *
 * ==========================================================================
 *  WHY THIS IS AN ID TOKEN, NOT A CLASSIC OAUTH REDIRECT
 * ==========================================================================
 *
 * There are two different things people mean by "add OAuth":
 *
 *   1. Google Identity Services (GIS) "Sign in with Google" button: the
 *      BROWSER talks to Google directly, gets back a signed ID token (a
 *      JWT saying "Google vouches this is alice@gmail.com"), and hands
 *      that token to our own server to verify. No redirect away from the
 *      site, no client secret anywhere.
 *
 *   2. The classic OAuth2 "authorization code" redirect flow: the SERVER
 *      exchanges a code for tokens using a CLIENT SECRET, typically used
 *      when you need ongoing API access (reading someone's calendar,
 *      posting on their behalf), not just "who is this".
 *
 * This app only needs to know who someone is, once, to log them in --
 * exactly what (1) is for. So there is no GOOGLE_CLIENT_SECRET anywhere in
 * this codebase, and there does not need to be one: verifying an ID token
 * only requires the CLIENT ID (to check the token was actually issued for
 * this app), which is not a secret -- it is sent to the browser and
 * embedded in the page source deliberately.
 *
 * ==========================================================================
 *  WHY google-auth-library, NOT HAND-ROLLED JWT VERIFICATION
 * ==========================================================================
 *
 * Verifying a JWT correctly means checking the signature against the
 * ISSUER'S CURRENT signing keys (which rotate), the issuer, the audience,
 * and the expiry -- getting any one of those wrong is a real
 * authentication bypass, not a cosmetic bug. This is Google's own
 * officially maintained library for exactly this check; there is no
 * "simpler" hand-written version of this that is actually safe.
 */

const { OAuth2Client } = require("google-auth-library");

const clientId = () => process.env.GOOGLE_CLIENT_ID;

let cachedClient = null;
const getClient = () => {
  if (cachedClient) return cachedClient;
  cachedClient = new OAuth2Client(clientId());
  return cachedClient;
};

const googleSignInIsConfigured = () => Boolean(clientId());

/**
 * Test-only override, mirroring utils/mailer.js's onTestMail: lets the
 * Jest suite exercise every real branch of the account-linking logic in
 * controllers/googleAuthController.js (new account, existing account,
 * admin-role refusal, bad token) without a real signed token from Google's
 * live servers, which a test cannot produce.
 */
let testVerifier = null;
const setTestVerifier = (fn) => {
  testVerifier = fn;
};

/**
 * Verifies an ID token and returns the identity it proves.
 *
 * Throws if the token is invalid, expired, or was not issued for this
 * app's client ID -- the caller (googleAuthController.js) turns that into
 * a 401, never a 500: an invalid token is an expected outcome of a public
 * endpoint, not a server fault.
 */
const verifyGoogleIdToken = async (idToken) => {
  if (process.env.NODE_ENV === "test" && typeof testVerifier === "function") {
    return testVerifier(idToken);
  }

  if (!googleSignInIsConfigured()) {
    throw new Error(
      "Google Sign-In is not configured. Set GOOGLE_CLIENT_ID in server/.env."
    );
  }

  const ticket = await getClient().verifyIdToken({
    idToken,
    audience: clientId(),
  });

  const payload = ticket.getPayload();

  return {
    googleId: payload.sub,
    email: String(payload.email || "").toLowerCase(),
    // Google can issue a token for an email it has not itself confirmed
    // (an unusual Workspace configuration). Treating that as equivalent to
    // our own verified-email guarantee would be wrong, so the caller
    // checks this explicitly rather than assuming every Google token
    // implies a verified address.
    emailVerified: payload.email_verified === true,
    name: payload.name || payload.email,
  };
};

module.exports = { verifyGoogleIdToken, googleSignInIsConfigured, setTestVerifier };
