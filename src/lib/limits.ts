// Size limits on user-supplied content.
//
// Without these, a single request can push an unbounded document into SQLite -
// which search then scans on every query, backup serializes on every tick, and
// the RSC payload ships to the browser on every page load. The numbers are
// generous for real documents and hostile to abuse.

import { attachmentQuotaBytes } from "@/lib/attachments";

/** A page's serialized ProseMirror document. ~2 MB of JSON is a very long page. */
export const MAX_CONTENT = 2 * 1024 * 1024;

/**
 * Ceiling on a page document arriving from a backup FILE.
 *
 * Deliberately not MAX_CONTENT. MAX_CONTENT bounds what one save request may
 * push in; it is not a statement about what a page row in an existing database
 * may be. Rows above it exist for reasons that have nothing to do with the
 * uploader: the OneNote mirror writes page content with no cap of its own, and
 * a page saved at exactly MAX_CONTENT can grow when a restore rewrites its
 * /api/attachments/<id> URLs. Enforcing the save limit on the way back in made
 * Keel refuse backups Keel itself had written, and - because page duplication
 * shares this path - turned duplicating a big page into a 500.
 *
 * So the file ceiling is set where no row Keel could have produced can reach:
 * it refuses the hand-built hundred-megabyte document the cap exists for, and
 * refuses nothing a real workspace can hold. Both readers apply it to the same
 * string - the DECODED content - so they agree on which documents they refuse.
 */
export const MAX_RESTORED_CONTENT = 32 * 1024 * 1024;

/**
 * Ceiling on the RAW JSON TEXT of one row in a backup file.
 *
 * A different string from MAX_RESTORED_CONTENT, which is why it is a different
 * number. The streaming reader has to bound a row while it is still scanning
 * for that row's end, so all it can measure is the file text; the buffered
 * reader measures `page.content` after JSON.parse has unescaped it. Setting
 * both to MAX_RESTORED_CONTENT looked like agreement and was the opposite: a
 * page's content is itself JSON, so every `"` in it is `\"` inside the pages
 * row (~1.2x for a real ProseMirror document, plus the row's other fields), and
 * the streaming reader was therefore strictly the tighter of the two. A ~30 MiB
 * page - which the OneNote mirror can write, since it applies no content cap -
 * restored through /api/cloud/restore and was refused by import and on-disk
 * restore with "a pages row is larger than this build can read": Keel refusing
 * its own backup on the two paths people actually use, the exact failure
 * MAX_RESTORED_CONTENT was introduced to end.
 *
 * 4x, because escaping a content string can at most double it. Content that
 * survives the readers at all is parseable JSON (assertSnapshotShape runs
 * documentToPlainText over it), and valid JSON text carries no raw control
 * characters inside its strings - only `"` and `\` inflate, each to two
 * characters. The remaining 2x plus a megabyte is headroom for the rest of the
 * row (title, icon, type, ids).
 *
 * What this bound is NOT: a claim that the two readers accept precisely the
 * same bytes. Above it the streaming reader refuses rows the buffered one would
 * clamp or drop - a hand-built row with a 200 MiB title, say - because a
 * scanner that will hold any row a file names has no memory bound at all. That
 * line now sits far above every row Keel can write, which is the property that
 * matters: a backup Keel produced restores through every path that accepts
 * backups.
 */
export const MAX_RESTORED_ROW = 4 * MAX_RESTORED_CONTENT + 1024 * 1024;

/** Page and record titles. */
export const MAX_TITLE = 512;

/** A single database cell (JSON-encoded). */
export const MAX_VALUE = 64 * 1024;

/** A comment body - already enforced in the comments route. */
export const MAX_COMMENT = 5_000;

/**
 * Ceiling on an uploaded backup file.
 *
 * This is derived, not guessed, because the previous fixed 500 MB was a trap:
 * it sat *below* the size of the app's own backups and the comment beside it
 * claimed the opposite. A cap that rejects the app's own backups is not a cap.
 *
 * Two inflations stack between a workspace's bytes and the file it produces:
 *
 *   1. A v3 snapshot embeds attachment bytes as base64 - 4/3.
 *   2. An encrypted backup base64s the ciphertext into the envelope - 4/3
 *      again, so an encrypted file is 16/9 of the attachment bytes.
 *
 * So the honest floor is `attachment quota x 16/9`, plus headroom for the
 * non-attachment sections (pages, records, values), which the per-row limits
 * above bound but do not make small.
 *
 * What reading a file this size costs, precisely - the previous wording here
 * claimed it "never materializes it", which was true only of the attachment
 * bytes and was exactly the kind of untested assertion this file has been
 * corrected for before. readBackupStream() spools every attachment's `data`
 * straight to disk, so no attachment is ever resident. It DOES build the
 * non-attachment rows (pages, records, values, …) as JS objects, because a
 * restore needs them all at once. That is bounded not by this number but by
 * the per-section row caps in backup.ts (SECTION_CAPS), which the reader
 * enforces as rows stream in - a file that carries more rows than a section
 * allows is refused at the row that crosses the cap, not after the heap has
 * already absorbed the file. So this number bounds disk and time; the row caps
 * bound memory.
 */
export function maxBackupUploadBytes(): number {
  return Math.ceil((attachmentQuotaBytes() * 16) / 9) + 512 * 1024 * 1024;
}

/** Property/select-option names and similar short labels. */
export const MAX_NAME = 200;

export function tooLarge(what: string, limit: number): string {
  const readable =
    limit >= 1024 * 1024 ? `${Math.round(limit / 1024 / 1024)} MB` : `${limit.toLocaleString()} characters`;
  return `${what} is too large (limit ${readable}).`;
}
