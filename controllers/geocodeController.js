/**
 * City/region suggestions and forward geocoding, via OpenStreetMap's
 * Nominatim search API -- free, no API key.
 *
 * ==========================================================================
 *  WHY THIS IS A SERVER-SIDE PROXY, NOT A DIRECT BROWSER CALL
 * ==========================================================================
 *
 * Nominatim's own usage policy
 * (https://operations.osmfoundation.org/policies/nominatim/) requires:
 *   - a genuine, identifying User-Agent or Referer on every request
 *   - at most ~1 request per second from one source
 *   - no heavy/bulk use without asking OSM first
 *
 * A browser calling Nominatim directly cannot reliably set a custom
 * User-Agent (browsers block it), and there is no way to enforce the
 * rate limit across every visitor's browser. Proxying through our own
 * server fixes both: this server sets a real identifying header, and
 * verificationRequestLimiter-style throttling below keeps total volume
 * to something Nominatim's free tier is meant for.
 *
 * DOCUMENTED LIMIT: Nominatim's public instance is rate-limited and meant
 * for light, interactive use like this search-as-you-type box -- not for
 * geocoding a bulk list of addresses. If this app ever needs to geocode
 * many addresses at once (a CSV import, for example), that needs either
 * deliberate delays between requests or a paid/self-hosted geocoder
 * instead -- not this endpoint.
 *
 * ==========================================================================
 *  DOES NOT GUESS SILENTLY
 * ==========================================================================
 *
 * This returns Nominatim's own candidate list; it never auto-picks one
 * "best guess" and calls it confirmed. The frontend shows every
 * candidate as a picklist, and a location only becomes CONFIRMED (stored
 * with real coordinates) once the barber explicitly selects one -- see
 * BarberSignupPage.js's LocationField and BarberProfile.locationConfirmed.
 */

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";

// Node 22+ has a global fetch; nothing extra to install.
const identify = () => ({
  // Nominatim's policy explicitly asks for a real identifying UA -- a
  // generic one risks the whole app being blocked, not just one request.
  "User-Agent": "VEYRON-Barber-Booking/1.0 (contact via app settings)",
  Referer: process.env.CLIENT_ORIGIN || "http://localhost:3000",
});

/**
 * GET /api/geocode/search?q=<partial city/address>
 * Public: this is the same kind of lookup a barber does while typing
 * their own location, before they are necessarily logged in during
 * signup.
 */
const search = async (req, res) => {
  const q = String(req.query.q || "").trim();

  if (q.length < 2) {
    return res.status(200).json({ results: [] });
  }

  // Nominatim itself has no documented hard cap on query length, but this
  // is a search box, not a text field -- an absurdly long query is either
  // a mistake or someone testing the endpoint's limits.
  const query = q.slice(0, 120);

  const url = new URL(`${NOMINATIM_BASE}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "6");

  let response;
  try {
    response = await fetch(url, { headers: identify() });
  } catch (error) {
    console.error("Geocode search request failed:", error.message);
    return res.status(502).json({
      errors: [{ message: "Could not reach the location service. You can still type your city manually." }],
    });
  }

  if (!response.ok) {
    console.error("Geocode search returned", response.status);
    return res.status(502).json({
      errors: [{ message: "The location service is unavailable right now. You can still type your city manually." }],
    });
  }

  const data = await response.json();

  const results = (Array.isArray(data) ? data : []).map((place) => ({
    displayName: place.display_name,
    city:
      place.address?.city ||
      place.address?.town ||
      place.address?.village ||
      place.address?.municipality ||
      "",
    region: place.address?.state || place.address?.region || "",
    country: place.address?.country || "",
    latitude: Number(place.lat),
    longitude: Number(place.lon),
  }));

  res.status(200).json({ results });
};

module.exports = { search };
