/**
 * Rebuilds all 7 weekdays of a BarberProfile's workingHours from whatever
 * array was sent in a request body, so a day missing from the payload means
 * closed rather than silently keeping its old value.
 *
 * Pulled out of barberController.upsertMyBarberProfile so the admin-side
 * profile editor (adminBarberController.js) can do exactly the same
 * rebuild rather than a second, potentially-drifting copy of this logic.
 */
const buildWorkingHours = (sentArray) =>
  [0, 1, 2, 3, 4, 5, 6].map((day) => {
    const sent = (sentArray || []).find((entry) => Number(entry.day) === day);
    if (!sent) {
      return { day, isOpen: false, open: "09:00", close: "18:00", breakStart: "", breakEnd: "" };
    }
    return {
      day,
      isOpen: Boolean(sent.isOpen),
      open: sent.open || "09:00",
      close: sent.close || "18:00",
      breakStart: sent.breakStart || "",
      breakEnd: sent.breakEnd || "",
    };
  });

module.exports = { buildWorkingHours };
