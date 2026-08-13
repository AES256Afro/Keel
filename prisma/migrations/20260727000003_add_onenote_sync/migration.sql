ALTER TABLE "Workspace" ADD COLUMN "oneNoteRefreshToken" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "oneNoteEmail" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "oneNoteEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Workspace" ADD COLUMN "oneNoteLastSyncAt" DATETIME;
ALTER TABLE "Workspace" ADD COLUMN "oneNoteLastError" TEXT;

ALTER TABLE "Page" ADD COLUMN "externalSource" TEXT;
ALTER TABLE "Page" ADD COLUMN "externalId" TEXT;
ALTER TABLE "Page" ADD COLUMN "externalUpdatedAt" DATETIME;
ALTER TABLE "Page" ADD COLUMN "externalHash" TEXT;

CREATE UNIQUE INDEX "Page_workspaceId_externalSource_externalId_key"
ON "Page"("workspaceId", "externalSource", "externalId");
