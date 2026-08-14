CREATE TABLE "PageShare" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pageId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PageShare_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PageShare_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PageShare_pageId_key" ON "PageShare"("pageId");
CREATE UNIQUE INDEX "PageShare_tokenHash_key" ON "PageShare"("tokenHash");
CREATE INDEX "PageShare_expiresAt_idx" ON "PageShare"("expiresAt");
