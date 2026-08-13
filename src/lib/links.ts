// The link layer: [[wikilinks]] and #tags.
//
// Both are extracted from a page's flattened text and stored as rows. The
// document stays the single source of truth - these tables are rebuilt on every
// save - but "what links here" and "everything tagged #x" are reverse lookups,
// and answering those by scanning every page is what makes backlinks feel slow
// in tools that do it that way.
//
// A link to a page that does not exist yet is kept with a null target. Writing
// [[Some idea]] before that page exists is the point, and it resolves itself
// when a page with that title appears.

import { prisma } from "@/lib/prisma";

/**
 * `[[Target]]` and `[[Target|shown text]]`.
 *
 * Deliberately no newlines inside: an unclosed bracket at the end of a line
 * shouldn't swallow the rest of the document.
 */
const WIKILINK = /\[\[([^\[\]\n|]{1,200})(?:\|[^\[\]\n]{0,200})?\]\]/g;

/**
 * `#tag`.
 *
 * Must start at a word boundary so `C#` and a `#` inside a URL fragment don't
 * become tags, and must contain a non-digit so `#1` (an issue reference) isn't
 * mistaken for one. Nested tags (`#work/urgent`) are allowed - people organise
 * that way and it costs nothing to permit.
 */
const TAG = /(?:^|[\s(])#([\p{L}][\p{L}\p{N}_/-]{0,60})/gu;

export interface ExtractedLinks {
  /** Distinct link targets, in the order they first appear. */
  targets: string[];
  /** Distinct tags: `tag` normalised for lookup, `label` as written. */
  tags: { tag: string; label: string }[];
}

/** Normalise a page title for comparison - case and whitespace insensitive. */
export function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

export function extractLinks(text: string): ExtractedLinks {
  const targets: string[] = [];
  const seenTargets = new Set<string>();
  for (const m of text.matchAll(WIKILINK)) {
    const target = m[1].trim().replace(/\s+/g, " ");
    if (!target) continue;
    const key = normalizeTitle(target);
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);
    targets.push(target);
    // A page linking to hundreds of others is either generated or a mistake;
    // either way it should not be able to write unbounded rows.
    if (targets.length >= 200) break;
  }

  const tags: { tag: string; label: string }[] = [];
  const seenTags = new Set<string>();
  for (const m of text.matchAll(TAG)) {
    const label = m[1].replace(/[/-]+$/, "");
    if (!label || !/\p{L}/u.test(label)) continue;
    // A CSS colour is not a tag. #ff0000 starts with a letter and would
    // otherwise pass, while #123456 would not - which is worse than either
    // answer consistently. Only the valid colour lengths are excluded, so
    // #face (a real word) survives and #facade is untouched.
    if (/^[0-9a-f]+$/i.test(label) && [3, 4, 6, 8].includes(label.length)) continue;
    const tag = label.toLowerCase();
    if (seenTags.has(tag)) continue;
    seenTags.add(tag);
    tags.push({ tag, label });
    if (tags.length >= 100) break;
  }

  return { targets, tags };
}

/**
 * Map link targets to page ids, case-insensitively.
 *
 * Two queries instead of a workspace scan. An exact-title `in` lookup catches
 * almost everything - the picker inserts the title verbatim - and only the
 * leftovers need a per-target `contains`, which SQLite matches
 * case-insensitively for ASCII. Loading every page in the workspace to do this
 * in memory would put an O(workspace) query on every keystroke-batch save.
 */
async function resolveTargets(
  workspaceId: string,
  targets: string[]
): Promise<Map<string, string>> {
  const byTitle = new Map<string, string>();
  if (targets.length === 0) return byTitle;

  const remember = (rows: { id: string; title: string }[]) => {
    for (const row of rows) {
      const key = normalizeTitle(row.title);
      // First match wins, so a duplicate title resolves deterministically.
      if (key && !byTitle.has(key)) byTitle.set(key, row.id);
    }
  };

  remember(
    await prisma.page.findMany({
      where: { workspaceId, archivedAt: null, title: { in: targets } },
      select: { id: true, title: true },
      take: 500,
    })
  );

  const unresolved = targets.filter((t) => !byTitle.has(normalizeTitle(t)));
  if (unresolved.length > 0) {
    remember(
      await prisma.page.findMany({
        where: {
          workspaceId,
          archivedAt: null,
          // `contains` rather than `equals`: SQLite's `=` is case-sensitive and
          // Prisma's insensitive mode is PostgreSQL-only. Over-matching is fine
          // - remember() only keeps exact normalized equality below.
          OR: unresolved.slice(0, 25).map((t) => ({ title: { contains: t } })),
        },
        select: { id: true, title: true },
        take: 500,
      })
    );
    // Drop anything `contains` over-matched (e.g. "Roadmap" ← "Roadmap 2026").
    for (const [key, id] of [...byTitle]) {
      if (!targets.some((t) => normalizeTitle(t) === key)) byTitle.delete(key);
      else void id;
    }
  }
  return byTitle;
}

/**
 * Rewrite a page's links and tags to match its current content.
 *
 * Delete-then-insert rather than diffing: the row count per page is small, and
 * a diff has to be right about ordering, casing and duplicates to avoid drift.
 * Correctness over cleverness for something that runs on every save.
 */
export async function syncPageLinks(page: {
  id: string;
  workspaceId: string;
  plainText: string | null;
  title: string;
}): Promise<void> {
  const { targets, tags } = extractLinks(page.plainText ?? "");

  const byTitle = await resolveTargets(page.workspaceId, targets);

  await prisma.$transaction([
    prisma.pageLink.deleteMany({ where: { fromPageId: page.id } }),
    prisma.pageTag.deleteMany({ where: { pageId: page.id } }),
    ...(targets.length > 0
      ? [
          prisma.pageLink.createMany({
            data: targets.map((target) => ({
              workspaceId: page.workspaceId,
              fromPageId: page.id,
              // A page linking to itself is noise in its own backlinks pane.
              toPageId:
                byTitle.get(normalizeTitle(target)) === page.id
                  ? null
                  : byTitle.get(normalizeTitle(target)) ?? null,
              targetTitle: target,
            })),
          }),
        ]
      : []),
    ...(tags.length > 0
      ? [
          prisma.pageTag.createMany({
            data: tags.map((t) => ({
              workspaceId: page.workspaceId,
              pageId: page.id,
              tag: t.tag,
              label: t.label,
            })),
          }),
        ]
      : []),
  ]);
}

/**
 * Attach previously unresolved links to a page that now exists.
 *
 * Called when a page is created or renamed. Without this, writing [[Roadmap]]
 * and then creating Roadmap would leave the link dangling until the source page
 * happened to be edited again.
 */
export async function resolveLinksTo(page: {
  id: string;
  workspaceId: string;
  title: string;
}): Promise<number> {
  const title = normalizeTitle(page.title);
  if (!title) return 0;

  const unresolved = await prisma.pageLink.findMany({
    where: { workspaceId: page.workspaceId, toPageId: null },
    select: { id: true, targetTitle: true },
  });
  const matching = unresolved
    .filter((l) => normalizeTitle(l.targetTitle) === title)
    .map((l) => l.id);
  if (matching.length === 0) return 0;

  const { count } = await prisma.pageLink.updateMany({
    where: { id: { in: matching } },
    data: { toPageId: page.id },
  });
  return count;
}

/**
 * Detach links that pointed at a page which no longer answers to that title.
 *
 * A rename should not leave [[Old name]] silently pointing at the renamed page -
 * the text says one thing and the graph another. They become unresolved again,
 * which is visible and fixable.
 */
export async function unresolveStaleLinks(page: {
  id: string;
  title: string;
}): Promise<number> {
  const title = normalizeTitle(page.title);
  const links = await prisma.pageLink.findMany({
    where: { toPageId: page.id },
    select: { id: true, targetTitle: true },
  });
  const stale = links.filter((l) => normalizeTitle(l.targetTitle) !== title).map((l) => l.id);
  if (stale.length === 0) return 0;
  const { count } = await prisma.pageLink.updateMany({
    where: { id: { in: stale } },
    data: { toPageId: null },
  });
  return count;
}

export interface Backlink {
  pageId: string;
  title: string;
  icon: string | null;
  type: string;
  /** Text around the link, for context in the pane. */
  excerpt: string | null;
}

/** Pages that link here. */
export async function getBacklinks(pageId: string): Promise<Backlink[]> {
  const links = await prisma.pageLink.findMany({
    where: { toPageId: pageId },
    include: {
      from: {
        select: { id: true, title: true, icon: true, type: true, plainText: true, archivedAt: true },
      },
    },
    take: 100,
  });

  const seen = new Set<string>();
  const out: Backlink[] = [];
  for (const link of links) {
    if (link.from.archivedAt) continue; // trashed pages are not backlinks
    if (seen.has(link.from.id)) continue;
    seen.add(link.from.id);
    out.push({
      pageId: link.from.id,
      title: link.from.title || "Untitled",
      icon: link.from.icon,
      type: link.from.type,
      excerpt: excerptAround(link.from.plainText, link.targetTitle),
    });
  }
  return out;
}

/** The sentence-ish fragment containing a link, for the backlinks pane. */
function excerptAround(text: string | null, target: string, radius = 80): string | null {
  if (!text) return null;
  const needle = `[[${target}`;
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return null;
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + needle.length + radius);
  return (
    (start > 0 ? "…" : "") +
    text.slice(start, end).replace(/\n/g, " ").trim() +
    (end < text.length ? "…" : "")
  );
}

export interface TagSummary {
  tag: string;
  label: string;
  count: number;
}

/** Every tag in the workspace, most used first. */
export async function listTags(workspaceId: string): Promise<TagSummary[]> {
  const rows = await prisma.pageTag.findMany({
    where: { workspaceId, page: { archivedAt: null } },
    select: { tag: true, label: true },
  });
  const counts = new Map<string, TagSummary>();
  for (const r of rows) {
    const existing = counts.get(r.tag);
    if (existing) existing.count += 1;
    else counts.set(r.tag, { tag: r.tag, label: r.label, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
