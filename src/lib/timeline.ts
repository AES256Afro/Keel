// Date arithmetic for the timeline view.
//
// Everything works in whole days since the epoch, computed in UTC. Date
// property values are bare "YYYY-MM-DD" strings - no time, no zone - and the
// notorious trap is that `new Date("2026-08-03")` parses as UTC midnight while
// `new Date(2026, 7, 3)` builds local midnight, so mixing the two shifts every
// bar by a day for anyone west of Greenwich. Integer day numbers cannot drift.

const MS_PER_DAY = 86_400_000;

/** "YYYY-MM-DD" → whole days since the epoch, or null for anything else. */
export function parseDay(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d));
  if (Number.isNaN(ms)) return null;
  // Reject impossible dates that Date.UTC would silently roll over
  // (2026-02-31 → March 3rd), which would place a bar on a date the record
  // does not actually contain.
  const check = new Date(ms);
  if (check.getUTCMonth() !== Number(mo) - 1 || check.getUTCDate() !== Number(d)) return null;
  return Math.floor(ms / MS_PER_DAY);
}

/** Whole days since the epoch → "YYYY-MM-DD". */
export function formatDay(day: number): string {
  const d = new Date(day * MS_PER_DAY);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export interface TimelineSpan {
  recordId: string;
  /** Inclusive, days since epoch. */
  start: number;
  /** Inclusive; equals start for a single-date record. */
  end: number;
}

/**
 * A record's place on the axis, from its date property value(s).
 *
 * An end before the start is treated as a single-day event at the start rather
 * than rendering a negative-width bar or silently swapping the user's data.
 */
export function spanOf(
  recordId: string,
  startValue: unknown,
  endValue: unknown
): TimelineSpan | null {
  const start = parseDay(startValue);
  if (start === null) return null;
  const end = parseDay(endValue);
  return { recordId, start, end: end !== null && end >= start ? end : start };
}

export interface TimelineRange {
  /** First visible day, inclusive. */
  min: number;
  /** Last visible day, inclusive. */
  max: number;
}

/**
 * The visible window: every span plus today, padded so nothing sits on the
 * edge. Today is always inside the range so the "now" line has somewhere to
 * be, even when every record is in the past or the future.
 */
export function rangeOf(spans: TimelineSpan[], today: number, pad = 7): TimelineRange {
  let min = today;
  let max = today;
  for (const s of spans) {
    if (s.start < min) min = s.start;
    if (s.end > max) max = s.end;
  }
  return { min: min - pad, max: max + pad };
}

export interface MonthTick {
  /** Day the month starts (clamped to the range start for the first). */
  day: number;
  /** e.g. "Aug 2026". */
  label: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * One tick per month boundary inside the range, plus one for the range start.
 *
 * Capped: the range comes from user-entered dates, and a record dated year
 * 9999 (a typo, or a paste) would otherwise emit ~96,000 ticks and render
 * 96,000 DOM nodes - the browser tab stops responding. Beyond the cap the axis
 * is simply less granular, which is the right failure for a view of a range
 * that large anyway.
 */
const MAX_MONTH_TICKS = 600; // 50 years of monthly ticks

export function monthTicks(range: TimelineRange): MonthTick[] {
  const out: MonthTick[] = [];
  const first = new Date(range.min * MS_PER_DAY);
  let y = first.getUTCFullYear();
  let m = first.getUTCMonth();
  out.push({ day: range.min, label: `${MONTHS[m]} ${y}` });
  for (;;) {
    m += 1;
    if (m === 12) {
      m = 0;
      y += 1;
    }
    const day = Math.floor(Date.UTC(y, m, 1) / MS_PER_DAY);
    if (day > range.max) break;
    if (out.length >= MAX_MONTH_TICKS) break;
    out.push({ day, label: `${MONTHS[m]} ${y}` });
  }
  return out;
}

/**
 * Pixels per day chosen so the whole range roughly fits the viewport, clamped
 * to stay usable at both extremes: a two-day database must not become two
 * 500px-wide bars, and a five-year one must not collapse below a pixel a week.
 */
export function pxPerDay(range: TimelineRange, viewportWidth: number): number {
  const days = Math.max(1, range.max - range.min);
  return Math.min(24, Math.max(0.75, viewportWidth / days));
}
