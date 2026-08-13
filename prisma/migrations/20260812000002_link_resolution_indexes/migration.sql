-- CreateIndex
CREATE INDEX "Page_workspaceId_title_idx" ON "Page"("workspaceId", "title");

-- CreateIndex
CREATE INDEX "PageLink_workspaceId_toPageId_idx" ON "PageLink"("workspaceId", "toPageId");

