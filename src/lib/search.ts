// Query parsing and result ranking.
//
// Kept out of the route so it can be tested without a database, and so the
// operator grammar is one readable thing rather than scattered through a query
// builder.

export interface ParsedQuery {
  /** Bare words, all of which must match. */
  terms: string[];
  /** "Quoted phrases", matched as written. */
  phrases: string[];
  /** in:title - ignore the body. */
  titleOnly: boolean;
  /** type:document|database|record */
  types: string[];
  /** updated:7d | 24h | 30d - only pages touched since. */
  updatedAfter: Date | null;
}

const VALID_TYPES = new Set(["document", "database", "record"]);

/**
 * Prisma does not escape LIKE wildcards in `contains`, and does not expose an
 * ESCAPE clause - so a search for "%" matches every page and "a_c" matches
 * "abc". Wildcards are stripped for the database pre-filter, and the literal
 * needle is re-checked in memory (see matchesLiterally), so the result set is
 * correct without losing the ability to type a "%" at all.
 */
export function forDatabaseFilter(needle: string): string {
  return needle.replace(/[%_\\]/g, "");
}

/**
 * A case-insensitive `contains` filter that means the same thing on both
 * supported providers.
 *
 * Prisma's `contains` compiles to a bare LIKE. SQLite's LIKE is
 * case-insensitive for ASCII, PostgreSQL's is not - so on PostgreSQL the SQL
 * pre-filter dropped rows the in-memory check (matchesLiterally, which
 * lowercases both sides) would have kept: searching "roadmap" found nothing
 * for a page titled "Roadmap", and the pre-filter can only narrow, never
 * recover. `mode: "insensitive"` is the fix, but it is PostgreSQL-only - the
 * SQLite client rejects the argument outright - so it is added only when the
 * connection string says PostgreSQL, which is also exactly when the client was
 * generated for it (see scripts/db-provider.mjs).
 */
export function containsInsensitive(
  value: string,
  databaseUrl: string | undefined = process.env.DATABASE_URL
): { contains: string; mode?: "insensitive" } {
  return /^postgres(ql)?:\/\//i.test(databaseUrl ?? "")
    ? { contains: value, mode: "insensitive" }
    : { contains: value };
}

/** Does this page really contain the needle, wildcards taken literally? */
export function matchesLiterally(
  page: { title: string; plainText: string | null },
  needle: string,
  titleOnly: boolean
): boolean {
  const n = needle.toLowerCase();
  if (page.title.toLowerCase().includes(n)) return true;
  if (titleOnly) return false;
  return (page.plainText ?? "").toLowerCase().includes(n);
}

/** Parse `updated:7d`, `updated:24h`, `updated:3w`. */
function parseAge(value: string): Date | null {
  const m = /^(\d+)([hdw])$/.exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0 || n > 3650) return null;
  const hours = m[2] === "h" ? n : m[2] === "d" ? n * 24 : n * 24 * 7;
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

export function parseQuery(raw: string): ParsedQuery {
  const out: ParsedQuery = {
    terms: [],
    phrases: [],
    titleOnly: false,
    types: [],
    updatedAfter: null,
  };

  // Pull quoted phrases out first so their spaces don't split into terms.
  const rest = raw.replace(/"([^"]+)"/g, (_, phrase: string) => {
    const trimmed = phrase.trim();
    if (trimmed) out.phrases.push(trimmed);
    return " ";
  });

  for (const token of rest.split(/\s+/)) {
    if (!token) continue;
    const op = /^(\w+):(.+)$/.exec(token);
    if (op) {
      const [, key, value] = op;
      switch (key.toLowerCase()) {
        case "in":
          if (value.toLowerCase() === "title") out.titleOnly = true;
          continue;
        case "type": {
          const t = value.toLowerCase();
          if (VALID_TYPES.has(t)) out.types.push(t);
          continue;
        }
        case "updated": {
          const since = parseAge(value.toLowerCase());
          if (since) out.updatedAfter = since;
          continue;
        }
      }
    }
    // Not an operator (or an unknown one) - treat it as a search term, so a
    // page genuinely containing "type:foo" is still findable.
    out.terms.push(token);
  }

  // Very short terms match almost everything and make the scan expensive.
  out.terms = out.terms.filter((t) => t.length >= 2).slice(0, 8);
  out.phrases = out.phrases.slice(0, 4);
  return out;
}

interface Rankable {
  title: string;
  plainText: string | null;
  updatedAt: Date;
}

/**
 * Score a result.
 *
 * Title beats body; a whole-word hit beats a substring; an exact title match
 * wins outright. Recency only breaks ties - sorting purely by updatedAt (what
 * this used to do) buries the page you actually meant under whatever you edited
 * this morning.
 */
function score(page: Rankable, needles: string[]): number {
  const title = page.title.toLowerCase();
  const body = (page.plainText ?? "").toLowerCase();
  let total = 0;

  for (const needle of needles) {
    const n = needle.toLowerCase();
    if (title === n) total += 100;
    else if (title.startsWith(n)) total += 40;
    else if (new RegExp(`\\b${escapeRegExp(n)}`).test(title)) total += 25;
    else if (title.includes(n)) total += 12;

    if (body) {
      const wordHit = new RegExp(`\\b${escapeRegExp(n)}`, "g");
      const hits = (body.match(wordHit) ?? []).length;
      // Diminishing returns: ten mentions is not ten times as relevant.
      if (hits > 0) total += Math.min(15, 4 + Math.log2(hits) * 3);
      else if (body.includes(n)) total += 2;
    }
  }

  // At most a few points, so it never outweighs a real title match.
  const ageDays = (Date.now() - page.updatedAt.getTime()) / 86_400_000;
  total += Math.max(0, 5 - ageDays / 30);
  return total;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function rankResults<T extends Rankable>(pages: T[], needles: string[]): T[] {
  return [...pages]
    .map((page) => ({ page, s: score(page, needles) }))
    .sort((a, b) => b.s - a.s || b.page.updatedAt.getTime() - a.page.updatedAt.getTime())
    .map(({ page }) => page);
}
