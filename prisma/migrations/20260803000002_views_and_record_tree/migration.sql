-- Saved views + the record tree.
--
-- Views make the board and the mind map two faces of the same records instead
-- of separate features: switch the view, keep the data. The tree columns on
-- DatabaseRecord are the edges the mind map draws.
--
-- The table rebuild below is how SQLite adds a self-referencing foreign key;
-- every existing row is copied across unchanged.

-- CreateTable
CREATE TABLE "DatabaseView" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "databaseId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'table',
    "sortOrder" REAL NOT NULL DEFAULT 0,
    "config" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DatabaseView_databaseId_fkey" FOREIGN KEY ("databaseId") REFERENCES "Database" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_DatabaseRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "databaseId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "sortOrder" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "parentRecordId" TEXT,
    "mapX" REAL,
    "mapY" REAL,
    "collapsed" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "DatabaseRecord_databaseId_fkey" FOREIGN KEY ("databaseId") REFERENCES "Database" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DatabaseRecord_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DatabaseRecord_parentRecordId_fkey" FOREIGN KEY ("parentRecordId") REFERENCES "DatabaseRecord" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_DatabaseRecord" ("createdAt", "databaseId", "id", "pageId", "sortOrder", "updatedAt") SELECT "createdAt", "databaseId", "id", "pageId", "sortOrder", "updatedAt" FROM "DatabaseRecord";
DROP TABLE "DatabaseRecord";
ALTER TABLE "new_DatabaseRecord" RENAME TO "DatabaseRecord";
CREATE UNIQUE INDEX "DatabaseRecord_pageId_key" ON "DatabaseRecord"("pageId");
CREATE INDEX "DatabaseRecord_databaseId_idx" ON "DatabaseRecord"("databaseId");
CREATE INDEX "DatabaseRecord_parentRecordId_idx" ON "DatabaseRecord"("parentRecordId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "DatabaseView_databaseId_idx" ON "DatabaseView"("databaseId");

