/* Revenue drop schedule — pure calculation, shared by the web app and the
 * server (which is why this is plain JS in shared/, like merkle.mjs).
 *
 * The payout clock belongs to HoodLock, not to the visitor: every deadline is
 * "Saturday 21:30 in Europe/Stockholm", whatever the viewer's device is set
 * to. Date has no timezone support of its own, so the conversion goes through
 * Intl: read what the Stockholm wall clock shows at a given instant, and
 * invert that to find the instant a given wall-clock time happens. The
 * inversion is done twice because the first guess can land on the wrong side
 * of a DST switch; the second pass corrects it. 21:30 itself can never fall
 * inside the skipped/repeated DST hour (02:00-03:00), so the result is always
 * a real, unambiguous instant.
 */

export const PAYOUT = {
  timeZone: "Europe/Stockholm",
  /** 6 = Saturday (Date.getUTCDay numbering). */
  weekday: 6,
  hour: 21,
  minute: 30,
  /** First distribution: Saturday, August 8, 2026. The feature went live one
   *  week earlier, so a countdown started before this date must aim here and
   *  not at the launch Saturday itself. */
  first: { year: 2026, month: 8, day: 8 },
  /** How long after the deadline the UI shows "processing" before it rolls
   *  over to the next week when no status endpoint answers. */
  processingMs: 45 * 60_000,
};

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: PAYOUT.timeZone,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hourCycle: "h23",
});

/** What the Stockholm wall clock reads at instant `t` (ms epoch). */
function wallClock(t) {
  const out = {};
  for (const { type, value } of partsFmt.formatToParts(t)) {
    if (type !== "literal") out[type] = Number(value);
  }
  return out;
}

/** Zone offset at instant `t`, as (wall-clock-read-as-UTC) minus t. */
function zoneOffset(t) {
  const w = wallClock(t);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(t / 1000) * 1000;
}

/** The instant at which the Stockholm wall clock shows y-m-d h:mi. */
export function instantAt(year, month, day, hour, minute) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const once = guess - zoneOffset(guess);
  return guess - zoneOffset(once);
}

export const firstPayout = () =>
  instantAt(PAYOUT.first.year, PAYOUT.first.month, PAYOUT.first.day, PAYOUT.hour, PAYOUT.minute);

/** Next payout instant strictly after `now`, never before the first payout. */
export function nextPayout(now) {
  for (let i = 0; i < 9; i++) {
    const w = wallClock(now + i * 86_400_000);
    if (new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay() !== PAYOUT.weekday) continue;
    const t = instantAt(w.year, w.month, w.day, PAYOUT.hour, PAYOUT.minute);
    if (t > now) return Math.max(t, firstPayout());
  }
  // Unreachable: any 9-day window contains a Saturday. Kept as a hard fail
  // rather than a silent wrong date.
  throw new Error("no payout date found");
}

/** Most recent payout instant at or before `now`, or null before the first. */
export function previousPayout(now) {
  const first = firstPayout();
  if (now < first) return null;
  for (let i = 0; i < 9; i++) {
    const w = wallClock(now - i * 86_400_000);
    if (new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay() !== PAYOUT.weekday) continue;
    const t = instantAt(w.year, w.month, w.day, PAYOUT.hour, PAYOUT.minute);
    if (t <= now) return t;
  }
  return null;
}

/** Where the weekly cycle stands right now. `complete` is only ever entered
 *  from real backend data, never from the clock alone. */
export function dropPhase(now, status) {
  const prev = previousPayout(now);
  if (prev !== null && now - prev < PAYOUT.processingMs) {
    if (status.state === "complete") return { phase: "complete", since: prev, target: nextPayout(now) };
    return { phase: "processing", since: prev, target: nextPayout(now) };
  }
  return { phase: "countdown", target: nextPayout(now) };
}

export function countdownParts(msLeft) {
  const s = Math.max(0, Math.floor(msLeft / 1000));
  return {
    days: Math.floor(s / 86_400),
    hours: Math.floor((s % 86_400) / 3600),
    minutes: Math.floor((s % 3600) / 60),
    seconds: s % 60,
  };
}

/** "Saturday, August 8" for the payout instant, in HoodLock time. */
export function payoutDateLabel(t) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: PAYOUT.timeZone, weekday: "long", month: "long", day: "numeric",
  }).format(t);
}

/** The same instant on the visitor's own clock, or null when it matches
 *  Stockholm and saying it twice would just be noise. */
export function localTimeLabel(t) {
  const local = new Intl.DateTimeFormat("en-US", {
    weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(t);
  const stockholm = new Intl.DateTimeFormat("en-US", {
    timeZone: PAYOUT.timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(t);
  return local === stockholm ? null : local;
}
