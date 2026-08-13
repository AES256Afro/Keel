-- The link layer: [[wikilinks]] and #tags, derived from page content.
--
-- Both tables are DERIVED - the document is the truth and these are rebuilt on
-- every save. They exist as rows because "what links here" and "everything
-- tagged #x" are reverse lookups, and answering them by scanning every page is
-- what makes backlinks feel slow.
--
-- PageLink.toPageId is nullable on purpose: a link to a page that does not
-- exist yet is how you write forward, and it resolves itself when a page with
-- that title appears.

-- CreateTable
CREATE TABLE "PageLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "fromPageId" TEXT NOT NULL,
    "toPageId" TEXT,
    "targetTitle" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PageLink_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PageLink_fromPageId_fkey" FOREIGN KEY ("fromPageId") REFERENCES "Page" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PageLink_toPageId_fkey" FOREIGN KEY ("toPageId") REFERENCES "Page" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PageTag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    CONSTRAINT "PageTag_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PageTag_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "PageLink_toPageId_idx" ON "PageLink"("toPageId");

-- CreateIndex
CREATE INDEX "PageLink_fromPageId_idx" ON "PageLink"("fromPageId");

-- CreateIndex
CREATE INDEX "PageLink_workspaceId_targetTitle_idx" ON "PageLink"("workspaceId", "targetTitle");

-- CreateIndex
CREATE INDEX "PageTag_workspaceId_tag_idx" ON "PageTag"("workspaceId", "tag");

-- CreateIndex
CREATE UNIQUE INDEX "PageTag_pageId_tag_key" ON "PageTag"("pageId", "tag");

