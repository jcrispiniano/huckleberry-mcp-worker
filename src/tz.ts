/**
 * Timezone helpers.
 *
 * The Huckleberry backend stores every instant as a Unix timestamp in seconds
 * plus an `offset` field expressed in "Python style" minutes: positive west of
 * UTC (America/Sao_Paulo, UTC-3, is stored as +180). These helpers reproduce
 * that convention exactly so records written here are indistinguishable from
 * records written by the app.
 */

/**
 * Offset of `tz` at instant `at`, in milliseconds, using the usual sign
 * convention: positive east of UTC (UTC+2 -> +7200000).
 */
function utcOffsetMs(tz: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts: Record<string, number> = {};
  for (const p of dtf.formatToParts(at)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }

  // Intl renders hour 24 for midnight under hour12:false in some engines.
  const hour = parts.hour === 24 ? 0 : parts.hour;

  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    hour,
    parts.minute,
    parts.second,
  );

  return asIfUtc - at.getTime();
}

/**
 * Timezone offset in minutes, matching the Python client's sign convention
 * (`-utcoffset/60`): positive for UTC- zones. America/Sao_Paulo -> 180.
 */
export function offsetMinutes(tz: string, at: Date = new Date()): number {
  // Rounded because `utcOffsetMs` compares a second-precision wall clock
  // against a millisecond instant, which otherwise leaves sub-minute drift
  // (180.00765 instead of 180). Real UTC offsets are always whole minutes.
  return Math.round(-utcOffsetMs(tz, at) / 60000);
}

/**
 * Parse an ISO datetime into a Unix timestamp in seconds.
 *
 * A string carrying an explicit offset (`Z` or `+/-HH:MM`) is honoured as
 * written. A naive string is interpreted as wall-clock time in `tz`, which is
 * what the app means when a user types "15:47".
 */
export function isoToTimestamp(iso: string, tz: string): number {
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso.trim());

  if (hasZone) {
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) throw new Error(`Invalid ISO datetime: ${iso}`);
    return Math.floor(ms / 1000);
  }

  const naiveMs = Date.parse(`${iso.trim()}Z`);
  if (Number.isNaN(naiveMs)) throw new Error(`Invalid ISO datetime: ${iso}`);

  // Resolve twice so instants near a DST transition land on the right side.
  let ms = naiveMs - utcOffsetMs(tz, new Date(naiveMs));
  ms = naiveMs - utcOffsetMs(tz, new Date(ms));

  return Math.floor(ms / 1000);
}

/**
 * Start of a calendar day (YYYY-MM-DD) in `tz`, as a Unix timestamp.
 */
export function dateToTimestamp(date: string, tz: string): number {
  return isoToTimestamp(`${date}T00:00:00`, tz);
}

/**
 * End of a calendar day (YYYY-MM-DD) in `tz`: midnight of the following day.
 *
 * The Python server used start-of-day for both ends of a range, so asking for
 * a single day (start_date == end_date) produced an empty window and silently
 * returned no records. Ranges here are half-open [start, end).
 */
export function endDateToTimestamp(date: string, tz: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const iso = next.toISOString().slice(0, 10);
  return isoToTimestamp(`${iso}T00:00:00`, tz);
}

/**
 * Render a Unix timestamp as an ISO string in `tz`, e.g.
 * "2026-08-17T15:47:00-03:00". Sub-second precision is dropped.
 */
export function timestampToLocalIso(ts: number, tz: string): string {
  const at = new Date(Math.floor(ts) * 1000);

  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(at)) {
    if (part.type !== "literal") p[part.type] = part.value;
  }
  const hour = p.hour === "24" ? "00" : p.hour;

  const offMin = utcOffsetMs(tz, at) / 60000;
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  const offH = String(Math.floor(abs / 60)).padStart(2, "0");
  const offM = String(Math.round(abs % 60)).padStart(2, "0");

  return `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}:${p.second}${sign}${offH}:${offM}`;
}
