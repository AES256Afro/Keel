-- Searchable text, derived from the editor document.
--
-- Search LIKE'd over Page.content, which is the serialized ProseMirror
-- document: every page matched "paragraph", "doc", "type" and "text", while a
-- word split across two marks matched nothing. This column holds the flattened
-- visible text, and search reads it instead.
--
-- Existing rows are backfilled by the server on first boot (see
-- backfillPlainText in src/lib/server-init.ts) rather than here, because
-- flattening ProseMirror JSON is not something to attempt in SQL.
ALTER TABLE "Page" ADD COLUMN "plainText" TEXT;

-- Search filters by workspace and orders by updatedAt; this covers the scan.
CREATE INDEX "Page_workspaceId_archivedAt_updatedAt_idx"
  ON "Page"("workspaceId", "archivedAt", "updatedAt");
