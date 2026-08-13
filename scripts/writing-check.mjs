#!/usr/bin/env node
// Word counting and writing goals.
//
// Counting has to be honest to be worth anything: a count that moves when you
// reformat, or that ignores the language you write in, is worse than none
// because you stop trusting it.
//
//   node scripts/writing-check.mjs
import { register } from "node:module";
import path from "path";
import { pathToFileURL, fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
register("./ts-loader.mjs", import.meta.url);
const { toCsv } = await import(pathToFileURL(path.join(root, "src/lib/csv.ts")).href);
const { textStats, goalProgress, localDayKey } = await import(
  pathToFileURL(path.join(root, "src/lib/writing.ts")).href
);

let passed = 0;
const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(`${name}${detail ? ` - ${detail}` : ""}`);
    console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? ` - ${detail}` : ""}`);
  }
};

console.log("\nCounting words");
{
  check("counts plain words", textStats("one two three").words === 3);
  check("collapses repeated whitespace", textStats("one   two\n\n three").words === 3);
  check("ignores leading and trailing space", textStats("  hi  ").words === 1);
  check("empty text is zero", textStats("").words === 0 && textStats("   ").words === 0);

  // Punctuation alone is not a word - otherwise reformatting inflates the count.
  check("bare punctuation is not a word", textStats("hello - world").words === 2,
    String(textStats("hello - world").words));
  check("a hyphenated compound is one word", textStats("well-known").words === 1);
  check("numbers count", textStats("in 2026 we shipped").words === 4);

  // CJK has no spaces; counting per character is the convention there.
  check("counts CJK per character", textStats("你好世界").words === 4,
    String(textStats("你好世界").words));
  check("mixes CJK and latin", textStats("hello 世界").words === 3,
    String(textStats("hello 世界").words));
  check("counts kana", textStats("こんにちは").words === 5, String(textStats("こんにちは").words));
}

console.log("\nOther statistics");
{
  const s = textStats("one two three");
  check("counts characters", s.characters === 13, String(s.characters));
  check("counts characters without spaces", s.charactersNoSpaces === 11, String(s.charactersNoSpaces));
  check("estimates reading time", textStats("word ".repeat(400)).readingMinutes === 2,
    String(textStats("word ".repeat(400)).readingMinutes));
  check("anything non-empty reads in at least a minute", textStats("hi").readingMinutes === 1);
  check("empty text has no reading time", textStats("").readingMinutes === 0);
}

console.log("\nGoals");
{
  const goal = { dailyWords: 500, deadline: null };
  check("reports progress", goalProgress(250, goal).fraction === 0.5);
  check("knows when the goal is met", goalProgress(500, goal).met === true);
  check("does not exceed 1", goalProgress(9999, goal).fraction === 1);
  check("no goal means no fraction", goalProgress(100, { dailyWords: 0, deadline: null }).fraction === 0);
  check("no goal is never 'met'", goalProgress(100, { dailyWords: 0, deadline: null }).met === false);

  const today = localDayKey();
  const dueToday = goalProgress(0, { dailyWords: 100, deadline: today });
  check("a deadline today reads as 1 day left, not 0", dueToday.daysLeft === 1, String(dueToday.daysLeft));

  const past = goalProgress(0, { dailyWords: 100, deadline: "2000-01-01" });
  check("a past deadline is 0 days, never negative", past.daysLeft === 0, String(past.daysLeft));

  const bad = goalProgress(0, { dailyWords: 100, deadline: "not-a-date" });
  check("an unparseable deadline is ignored", bad.daysLeft === null, String(bad.daysLeft));
}

console.log("\nDay boundaries");
{
  check("formats as YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(localDayKey()));
  check("pads single digits", localDayKey(new Date(2026, 0, 5)) === "2026-01-05",
    localDayKey(new Date(2026, 0, 5)));
  // Local, not UTC: writing at 23:00 must count towards today where you are.
  check("uses the local day, not UTC", localDayKey(new Date(2026, 5, 1, 23, 30)) === "2026-06-01",
    localDayKey(new Date(2026, 5, 1, 23, 30)));
}

{
  // CSV formula-injection defence (found in sweep round 3).
  const cell = (v) => toCsv([[v]]).trimEnd();
  check("a formula-triggering = cell is defused", cell("=1+1") === "'=1+1" || cell("=1+1") === '"\'=1+1"', cell("=1+1"));
  check("+ - @ triggers are defused", cell("+x").startsWith("'") && cell("-x").startsWith("'") && cell("@x").startsWith("'"));
  check("a HYPERLINK payload is neutralised", cell('=HYPERLINK("http://evil","x")').startsWith("'") || cell('=HYPERLINK("http://evil","x")').startsWith('"\''));
  check("ordinary text is untouched", cell("Roadmap") === "Roadmap");
  // The guard must not mangle real data: negative numbers are values, not
  // formulas, and prefixing them silently broke spreadsheet sums.
  check("a negative number stays a number", cell("-5") === "-5", cell("-5"));
  check("a negative decimal stays a number", cell("-12.5") === "-12.5", cell("-12.5"));
  check("a signed exponent stays a number", cell("-1.2e-3") === "-1.2e-3", cell("-1.2e-3"));
  check("a plus-signed number stays a number", cell("+7") === "+7", cell("+7"));
  check("but -1+cmd is still defused", cell("-1+cmd|x").startsWith("'"), cell("-1+cmd|x"));
  check("a comma still forces quoting", toCsv([["a,b"]]).trimEnd() === '"a,b"');
  check("an embedded quote is doubled", toCsv([['he said "hi"']]).trimEnd() === '"he said ""hi"""');
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
