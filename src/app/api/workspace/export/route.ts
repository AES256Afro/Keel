import { NextRequest, NextResponse } from "next/server";
import { requireContext, enforceLimit, handleApiError } from "@/lib/api";
import {
  encryptedChunks,
  liveExportBytes,
  snapshotChunksOf,
  snapshotWorkspace,
  type Snapshot,
} from "@/lib/backup";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

/** Download a full workspace backup, optionally encrypted with a passphrase. */
export async function POST(req: NextRequest) {
  try {
    const { user, workspace } = await requireContext();
    // Reads the entire workspace - cheap to ask for, expensive to serve.
    await enforceLimit("export", { limit: 10, windowMs: 10 * 60_000, userId: user.id });
    const body = await req.json().catch(() => ({}));
    const passphrase =
      typeof body.passphrase === "string" && body.passphrase ? body.passphrase : undefined;

    const snapshot: Snapshot = await snapshotWorkspace(workspace.id);
    // A full export is an exfiltration primitive - a viewer can run one.
    await audit("workspace.export", user, {
      target: workspace.id,
      detail: { encrypted: Boolean(passphrase), pages: snapshot.pages.length },
    });
    const stamp = new Date().toISOString().slice(0, 10);
    const base = `keel-backup-${stamp}`;
    const filename = passphrase ? `${base}.keelbak` : `${base}.json`;

    // Streamed, not built. Assembling the response body as one string is the
    // ~400 MB ceiling that made Settings -> Export throw RangeError on any
    // workspace with a few hundred megabytes of attachments - a fifth of the
    // quota the app itself grants. Chunks go out as they are produced, and the
    // attachment bytes are loaded one row at a time inside the generator.
    const chunks = passphrase
      ? encryptedChunks(snapshotChunksOf(snapshot, liveExportBytes()), passphrase)
      : snapshotChunksOf(snapshot, liveExportBytes());
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      },
      cancel(reason) {
        void chunks.return?.(reason);
      },
    });

    return new NextResponse(stream, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
