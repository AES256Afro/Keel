# OneNote incremental mirror

Keel can mirror personal OneNote content into this read-only hierarchy:

```text
Imported
└── Notebook
    └── Section
        └── Page
```

OneNote remains authoritative. Duplicate an imported page into another Keel
folder before editing it independently.

## Microsoft setup

Create a Microsoft Entra app registration named `Keel OneNote Import`.

1. Choose accounts in any organizational directory and personal Microsoft
   accounts as the supported account type.
2. Add a web redirect URI using your real Keel origin:
   `https://notes.example.com/api/onenote/callback`.
3. Add delegated Microsoft Graph permissions:
   - `Notes.Read`
   - `User.Read`
   - `offline_access`
4. Create a client secret.
5. In Keel, open **Settings -> Integrations -> Microsoft**. Confirm the exact
   callback URL, then paste the application client ID and secret value. The
   secret field is write-only and changes apply immediately.

For an operator-managed deployment, set the same values in the server
environment instead. Environment values make the Microsoft panel read-only:

```dotenv
MS_CLIENT_ID=application-client-id
MS_CLIENT_SECRET=secret-value
KEEL_SYNC_SECRET=random-64-character-hex-value
```

`NOPIN_SYNC_SECRET` remains accepted as a backwards-compatible name, but new
deployments should use `KEEL_SYNC_SECRET`.

Generate the internal sync secret without printing it to a shared terminal log:

```bash
openssl rand -hex 32
```

Open Settings and select **Connect OneNote**. Microsoft will show a consent
screen for read-only notebook access. Keel calls a saved credential unverified
until this real authorization succeeds.

## Incremental behavior

Each sync:

1. Lists notebook, section, and page metadata.
2. Compares each stable OneNote page ID and `lastModifiedDateTime` with Keel.
3. Downloads HTML and images only for new or changed pages.
4. Stores images by SHA-256 content hash, so identical image bytes are reused.
5. Deletes mirrored pages that no longer exist in OneNote.
6. Deletes OneNote image files that are no longer referenced by a mirrored page.

Microsoft Graph does not provide a OneNote delta endpoint. The metadata scan is
therefore unavoidable, but it does not duplicate unchanged note content.

Image localization is sequential and each Graph image is capped at 40 MiB, so
only one bounded image is buffered at a time. A sync can write at most 256 MiB
and 1,000 new unique image files. Existing hash-deduplicated files do not use
that per-sync allowance. Across repeated syncs, persisted OneNote image bytes
share the configured workspace attachment quota with ordinary attachments, and
a workspace retains at most 10,000 OneNote image files. When a limit is reached,
page text continues importing and a later sync can resume after stale images
are cleaned up.

Each changed page's Graph HTML is also capped at 32 MiB from both declared and
actual streamed bytes. The converted TipTap JSON must remain within the same
32 MiB restore-safe content limit. A page that crosses either limit is skipped
without advancing its source timestamp, so a later sync can retry it while the
rest of the notebook continues.

## What is preserved

- notebook, section, and page names;
- page ordering within a section;
- headings, paragraphs, lists, links, basic emphasis, code, quotations, and
  images;
- updated pages and removed pages.

## Current limitations

- OneNote free-form canvas positioning is flattened into document order.
- Ink, handwriting, drawing coordinates, embedded Office files, audio, video,
  and general file attachments are not imported.
- OneNote page indentation levels are not recreated as nested Keel pages.
- A large initial migration can encounter Microsoft Graph rate limits. A later
  run resumes incrementally because completed pages keep their source IDs and
  modification timestamps.
- Removing a page from OneNote removes its read-only mirror after the next
  successful complete scan. Keep normal Keel backups for recovery.

## Scheduling

The deployment should call the sync endpoint locally on the Keel host and send
the secret using the `X-Keel-Sync-Secret` header. Do not expose the secret in a
command history, URL, public service file, or log.

Use **Sync now** in Keel Settings for an immediate run. An external scheduler
can call the same endpoint hourly after the Microsoft connection is complete.
