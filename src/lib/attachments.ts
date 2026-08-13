// Attachment storage rules.
//
// Files live as bytes in the database, not on disk. That single decision is
// what makes the safety story hold: Litestream replicates the database
// continuously, snapshots and restores carry everything, and a self-hosted
// move to a new machine is still "copy one file". The trade-off is size, so
// uploads are capped - images and PDFs are the use case, not videos.
//
// The serving rules exist because an attachment endpoint is a stored-XSS
// vector by default: let someone upload evil.svg (SVG runs scripts) or an
// HTML file, serve it inline from the app's origin, and any victim who opens
// the link runs the attacker's script with the victim's session. Two rules
// close that:
//
//   1. MIME comes from sniffing the bytes, never from the client. Only types
//      whose magic bytes we recognise - and which browsers can't execute
//      script from - may render inline. Everything else downloads.
//   2. Every response carries `Content-Security-Policy: sandbox` and
//      `nosniff`, so even a mislabelled body has no scripting context.

import { keelEnv } from "@/lib/env";

/** Types that may render in the browser. Script-capable formats (SVG, HTML,
 *  XML) are deliberately absent - they download instead. */
const INLINE: { mime: string; matches: (b: Buffer) => boolean }[] = [
  { mime: "image/png", matches: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/jpeg", matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/gif", matches: (b) => b.subarray(0, 4).toString("latin1") === "GIF8" },
  {
    mime: "image/webp",
    matches: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  },
  {
    mime: "image/avif",
    matches: (b) => b.subarray(4, 8).toString("latin1") === "ftyp" && ["avif", "avis"].includes(b.subarray(8, 12).toString("latin1")),
  },
  { mime: "application/pdf", matches: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
];

/** The sniffed inline-safe type, or null for "serve as a download". */
export function sniffInlineMime(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  return INLINE.find((t) => t.matches(bytes))?.mime ?? null;
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

const MB = 1024 * 1024;

/** Per-file ceiling. 50 MB covers full-page screenshots and short recordings
 *  comfortably; KEEL_MAX_ATTACHMENT_MB overrides in either direction. */
export function maxAttachmentBytes(): number {
  const mb = Number(keelEnv("MAX_ATTACHMENT_MB") ?? 50);
  return (Number.isFinite(mb) && mb > 0 ? mb : 50) * MB;
}

/** Per-workspace ceiling across all attachments (KEEL_ATTACHMENT_QUOTA_MB). */
export function attachmentQuotaBytes(): number {
  const mb = Number(keelEnv("ATTACHMENT_QUOTA_MB") ?? 2048);
  return (Number.isFinite(mb) && mb > 0 ? mb : 2048) * MB;
}

/** Strip a filename to something safe to echo into a header. */
export function safeFilename(name: string): string {
  const trimmed = name.replace(/[/\\]/g, "_").replace(/[\r\n"]/g, "").trim().slice(0, 120);
  return trimmed || "file";
}
