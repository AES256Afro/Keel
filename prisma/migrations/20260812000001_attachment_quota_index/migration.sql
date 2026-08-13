-- DropIndex
DROP INDEX "Attachment_workspaceId_idx";

-- CreateIndex
CREATE INDEX "Attachment_workspaceId_size_idx" ON "Attachment"("workspaceId", "size");

