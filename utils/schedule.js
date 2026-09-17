/**
 * Helpers for opening hours and appointment times.
 *
 * THE PROBLEM THESE SOLVE:
 * A booking time is stored as a Date, which is a single moment in time
 * (UTC underneath). But "we open at 09:00" is a LOCAL clock time at the
 * barber's shop. If your server runs in a different timezone from the
 * shop - which happens the moment you deploy to a cloud host - then
 * comparing them directly gives wrong answers, and customers get told
 * the shop is closed when it is open.
 *
 * So each barber profile stores an IANA timezone such as
 * "Europe/London" or "America/New_York", and we convert the requested
 * moment into that shop's local clock time before checking it.
 *
 * We use the built-in Intl API, so no date library is needed.
 */

/** "09:30" -> 570 (minutes since midnight). Returns null if malformed. */
const timeToMinutes = (value) => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || "").trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
};

/** 570 -> "09:30" */
const minutesToTime = (total) => {
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
};

/** Is this a timezone name Node actually recognises? */
const isValidTimeZone = (timeZone) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: String(timeZone) });
    return true;
  } catch {
    return false;
  }
};

const WEEKDAY_TO_NUMBER = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/**
 * Converts a moment in time into the shop's local weekday and clock time.
 *
 * Example: a booking at 2026-06-01T13:00:00Z for a shop in
 * "America/New_York" comes back as { day: 1 (Monday), minutes: 540 (09:00) }.
 */
const getLocalDayAndMinutes = (date, timeZone) => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    parts[part.type] = part.value;
  }

  // Some Node versions report midnight as hour "24" rather than "00".
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);

  return {
    day: WEEKDAY_TO_NUMBER[parts.weekday],
    minutes: hour * 60 + minute,
  };
};

/**
 * The shop's local CALENDAR DATE for a moment in time, as "YYYY-MM-DD".
 *
 * WHY A STRING KEY RATHER THAN A Date FOR time off:
 * "25 December" is a calendar-date concept, not a precise instant -- the
 * same ambiguity workingHours already avoids by storing "day" (0-6) instead
 * of a Date. Comparing "YYYY-MM-DD" strings works correctly with plain <=
 * and >=, because that format sorts lexicographically in the same order as
 * chronologically, so a range check needs no date-parsing at all.
 */
const getLocalDateKey = (date, timeZone) => {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA happens to format as YYYY-MM-DD, which is exactly the key we want.
  return formatter.format(date);
};

/** Does this shop-local calendar date fall inside any time-off range? */
const isDateInTimeOff = (dateKey, timeOff) =>
  (timeOff || []).some(
    (entry) => dateKey >= entry.startDate && dateKey <= entry.endDate
  );

/**
 * Checks an appointment fits inside the shop's opening hours for that day,
 * is not on a day the barber has blocked off (holiday / day off), and does
 * not fall inside that day's break, if one is set.
 *
 * workingHours is the array stored on the barber's profile, for example:
 *   [{ day: 1, isOpen: true, open: "09:00", close: "18:00",
 *      breakStart: "13:00", breakEnd: "13:30" }, ...]
 * timeOff is an optional array of { startDate: "YYYY-MM-DD", endDate }.
 *
 * Returns { ok: true } or { ok: false, reason: "..." }.
 */
const fitsWorkingHours = ({ startAt, endAt, timeZone, workingHours, timeOff }) => {
  const start = getLocalDayAndMinutes(startAt, timeZone);
  const end = getLocalDayAndMinutes(endAt, timeZone);

  const dateKey = getLocalDateKey(startAt, timeZone);
  if (isDateInTimeOff(dateKey, timeOff)) {
    return { ok: false, reason: "The barber is closed for time off on that day." };
  }

  const rule = (workingHours || []).find((entry) => entry.day === start.day);

  if (!rule || !rule.isOpen) {
    return { ok: false, reason: "The barber is closed on that day." };
  }

  const opensAt = timeToMinutes(rule.open);
  const closesAt = timeToMinutes(rule.close);

  if (opensAt === null || closesAt === null) {
    return { ok: false, reason: "The barber's opening hours are not set correctly." };
  }

  // If the appointment crosses midnight into the next day, the end weekday
  // differs from the start weekday. We do not support overnight
  // appointments, so reject it rather than silently allowing it.
  if (end.day !== start.day && end.minutes !== 0) {
    return { ok: false, reason: "Appointments cannot run past midnight." };
  }

  const endMinutes = end.day !== start.day ? 24 * 60 : end.minutes;

  if (start.minutes < opensAt) {
    return {
      ok: false,
      reason: `The barber opens at ${rule.open} on that day.`,
    };
  }

  if (endMinutes > closesAt) {
    return {
      ok: false,
      reason: `That appointment would finish after closing time (${rule.close}).`,
    };
  }

  if (rule.breakStart && rule.breakEnd) {
    const breakStartMin = timeToMinutes(rule.breakStart);
    const breakEndMin = timeToMinutes(rule.breakEnd);

    if (
      breakStartMin !== null &&
      breakEndMin !== null &&
      start.minutes < breakEndMin &&
      endMinutes > breakStartMin
    ) {
      return {
        ok: false,
        reason: `That time falls in the barber's break (${rule.breakStart}-${rule.breakEnd}).`,
      };
    }
  }

  return { ok: true };
};

/**
 * How far ahead of UTC a timezone is, in milliseconds, at a given moment.
 * Positive for east of UTC. Accounts for daylight saving automatically,
 * because it asks Intl what the clock actually reads at that instant.
 */
const getTimeZoneOffsetMs = (date, timeZone) => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    parts[part.type] = part.value;
  }

  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second)
  );

  return asIfUtc - date.getTime();
};

/**
 * Turns a wall-clock time in a timezone into a real moment (UTC).
 *
 * Example: (2026, 6, 1, 9, 0, "Europe/London") means
 * "1 June 2026 at 09:00 as the clock reads in London", and returns
 * 2026-06-01T08:00:00Z because London is on summer time then.
 *
 * WHY IT CALCULATES TWICE:
 * To find the offset we need a moment, but to find the moment we need the
 * offset. So we guess, measure the offset at the guess, correct, then
 * measure again. The second pass matters only on the two days a year when
 * the clocks change, but getting those wrong means double bookings.
 */
const zonedWallTimeToUtc = (year, month, day, hours, minutes, timeZone) => {
  const guess = Date.UTC(year, month - 1, day, hours, minutes);
  const firstPass = guess - getTimeZoneOffsetMs(new Date(guess), timeZone);
  const secondPass = guess - getTimeZoneOffsetMs(new Date(firstPass), timeZone);
  return new Date(secondPass);
};

/** Splits "2026-06-01" into { year, month, day }. Returns null if malformed. */
const parseDateOnly = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
};

module.exports = {
  timeToMinutes,
  minutesToTime,
  isValidTimeZone,
  getLocalDayAndMinutes,
  getLocalDateKey,
  isDateInTimeOff,
  fitsWorkingHours,
  getTimeZoneOffsetMs,
  zonedWallTimeToUtc,
  parseDateOnly,
};
