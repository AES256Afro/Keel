// Writing statistics and goals.
//
// Lattics has "Track Goals" - set a target and a deadline, and count what you
// write each day. The counting has to be honest to be worth anything: a word
// count that moves when you reformat, or a daily total that resets when you
// reopen a page, is worse than none because you stop trusting it.
//
// So: counts derive from the flattened text (not the editor document), and the
// daily figure is the difference between today's count and the count at the
// last midnight boundary - which means editing an old page still counts, and
// deleting text counts negatively rather than being ignored.

export interface TextStats {
  words: number;
  characters: number;
  /** Excludes whitespace - the figure most word processors show second. */
  charactersNoSpaces: number;
  /** At 200 wpm, rounded up, minimum 1 for anything non-empty. */
  readingMinutes: number;
}

/**
 * Count words the way a person would.
 *
 * Splitting on whitespace over-counts hyphenated compounds and under-counts
 * CJK, which has no spaces at all. CJK/Japanese/Korean characters are counted
 * individually - the convention those languages use - and everything else is
 * counted as whitespace-delimited runs.
 */
export function textStats(text: string): TextStats {
  const trimmed = text.trim();
  if (!trimmed) return { words: 0, characters: 0, charactersNoSpaces: 0, readingMinutes: 0 };

  const cjk = trimmed.match(/[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/gu);
  const cjkCount = cjk?.length ?? 0;

  // Remove CJK before the whitespace split so it isn't double-counted.
  const latin = cjkCount > 0 ? trimmed.replace(/[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/gu, " ") : trimmed;
  const latinWords = latin.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

  const words = latinWords + cjkCount;
  const characters = trimmed.length;
  return {
    words,
    characters,
    charactersNoSpaces: trimmed.replace(/\s/g, "").length,
    readingMinutes: words === 0 ? 0 : Math.max(1, Math.ceil(words / 200)),
  };
}

/** The day a timestamp belongs to, in the viewer's local zone, as YYYY-MM-DD. */
export function localDayKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export interface WritingGoal {
  /** Words per day. 0 means no goal. */
  dailyWords: number;
  /** ISO date the project is due, or null. */
  deadline: string | null;
}

export interface GoalProgress {
  written: number;
  target: number;
  /** 0–1, clamped. */
  fraction: number;
  met: boolean;
  /** Days left including today, or null when there's no deadline. */
  daysLeft: number | null;
}

export function goalProgress(written: number, goal: WritingGoal): GoalProgress {
  const target = Math.max(0, goal.dailyWords);
  let daysLeft: number | null = null;
  if (goal.deadline) {
    const due = new Date(`${goal.deadline}T23:59:59`);
    if (!Number.isNaN(due.getTime())) {
      // Including today, so "due today" reads as 1 rather than 0.
      daysLeft = Math.max(0, Math.ceil((due.getTime() - Date.now()) / 86_400_000));
    }
  }
  return {
    written,
    target,
    fraction: target === 0 ? 0 : Math.min(1, Math.max(0, written / target)),
    met: target > 0 && written >= target,
    daysLeft,
  };
}
