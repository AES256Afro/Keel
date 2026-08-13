#!/usr/bin/env node
// Date arithmetic behind the timeline view.
//
// All pure functions, so this is fast - and dates are where the silent bugs
// live: `new Date("2026-08-03")` parses as UTC midnight while local-time
// construction doesn't, which shifts every bar by a day for half the world.
// These tests run identically in any TZ; set TZ=America/New_York or
// TZ=Pacific/Kiritimati to prove it.
//
//   node --experimental-strip-types --no-warnings scripts/timeline-check.mjs
import { register } from "node:module";
import path from "path";
import { pathToFileURL, fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
register("./ts-loader.mjs", import.meta.url);
const { formatDay, monthTicks, parseDay, pxPerDay, rangeOf, spanOf } = await import(
  pathToFileURL(path.join(root, "src/lib/timeline.ts")).href
);

let passed = 0;
const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(`${name}${detail ? ` - ${detail}` : ""}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` - ${detail}` : ""}`);
  }
};

console.log(`\nTimeline maths (TZ=${process.env.TZ ?? "system"})\n`);

/* ---- parseDay ---- */

check("epoch day zero", parseDay("1970-01-01") === 0);
check("day one", parseDay("1970-01-02") === 1);
check("a known modern date", parseDay("2026-08-03") === 20668);
check("round-trips through formatDay", formatDay(parseDay("2026-08-03")) === "2026-08-03");
check("leap day parses", parseDay("2024-02-29") !== null);
check("Feb 29 in a non-leap year is rejected, not rolled over", parseDay("2026-02-29") === null);
check("Feb 31 is rejected", parseDay("2026-02-31") === null);
check("month 13 is rejected", parseDay("2026-13-01") === null);
check("a datetime string still yields its date part", parseDay("2026-08-03T15:30:00Z") === 20668);
check("empty string is null", parseDay("") === null);
check("garbage is null", parseDay("next tuesday") === null);
check("non-strings are null", parseDay(20668) === null && parseDay(null) === null);

/* ---- spanOf ---- */

{
  const s = spanOf("r1", "2026-08-03", null);
  check("a single date is a one-day span", s.start === s.end && s.start === 20668);
}
{
  const s = spanOf("r1", "2026-08-03", "2026-08-10");
  check("start and end make a span", s.end - s.start === 7);
}
{
  const s = spanOf("r1", "2026-08-10", "2026-08-03");
  check(
    "an end before the start collapses to a day, not a negative bar",
    s.start === parseDay("2026-08-10") && s.end === s.start
  );
}
check("no start date means no span", spanOf("r1", null, "2026-08-10") === null);
check("an invalid end is ignored, span survives", spanOf("r1", "2026-08-03", "nope").end === 20668);

/* ---- rangeOf ---- */

{
  const today = parseDay("2026-08-03");
  const r = rangeOf([], today);
  check("an empty timeline still contains today", r.min <= today && today <= r.max);
}
{
  const today = parseDay("2026-08-03");
  const spans = [spanOf("a", "2020-01-15", null), spanOf("b", "2020-03-01", "2020-04-01")];
  const r = rangeOf(spans, today);
  check("today is inside the range even when every record is years old", r.max >= today);
  check("the earliest record is inside the range", r.min <= parseDay("2020-01-15"));
  check("padding keeps bars off the edge", r.min < parseDay("2020-01-15"));
}

/* ---- monthTicks ---- */

{
  const r = { min: parseDay("2026-08-20"), max: parseDay("2026-11-10") };
  const ticks = monthTicks(r);
  check("first tick sits at the range start", ticks[0].day === r.min);
  check("first tick is labelled with its month", ticks[0].label === "Aug 2026", ticks[0].label);
  const labels = ticks.map((t) => t.label);
  check(
    "one tick per month boundary inside the range",
    labels.join("|") === "Aug 2026|Sep 2026|Oct 2026|Nov 2026",
    labels.join(", ")
  );
  check("ticks never pass the range end", ticks.every((t) => t.day <= r.max));
}
{
  const r = { min: parseDay("2026-11-20"), max: parseDay("2027-02-10") };
  const labels = monthTicks(r).map((t) => t.label);
  check(
    "ticks cross a year boundary",
    labels.join("|") === "Nov 2026|Dec 2026|Jan 2027|Feb 2027",
    labels.join(", ")
  );
}

/* ---- pxPerDay ---- */

{
  const week = { min: 0, max: 7 };
  const years = { min: 0, max: 365 * 5 };
  check("a short range is clamped, not blown up", pxPerDay(week, 1000) <= 24);
  check("a five-year range stays above the floor", pxPerDay(years, 1000) >= 0.75);
  const mid = { min: 0, max: 100 };
  check("a medium range roughly fits the viewport", Math.abs(pxPerDay(mid, 1000) - 10) < 0.2);
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m ${f}`);
  process.exit(1);
}
