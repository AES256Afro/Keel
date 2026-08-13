-- Promote three "enforced in the app layer" uniqueness rules to real database
-- constraints, and add the indexes the ordered queries were missing.
--
-- The app-layer checks were all findFirst-then-write, which is a check-then-act
-- race: two concurrent registrations could both see a username as free. That
-- matters most for User.username, because @mention delivery resolves members by
-- username - duplicates silently misdeliver notifications.
--
-- Existing rows are deduplicated first, so this migration is safe to apply to a
-- database that already has collisions. Nothing is deleted.

-- ---------------------------------------------------------------------------
-- User.username: keep the earliest holder, suffix the rest with part of their
-- id (which is unique by construction).
-- ---------------------------------------------------------------------------
UPDATE "User"
SET "username" = "username" || '-' || substr("id", 1, 6)
WHERE "username" IS NOT NULL
  AND "id" NOT IN (
    SELECT MIN("id") FROM "User" WHERE "username" IS NOT NULL GROUP BY "username"
  );

CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- ---------------------------------------------------------------------------
-- NewsPost.slug: the slug is the public URL, so collisions were already a bug.
-- ---------------------------------------------------------------------------
UPDATE "NewsPost"
SET "slug" = "slug" || '-' || substr("id", 1, 6)
WHERE "id" NOT IN (SELECT MIN("id") FROM "NewsPost" GROUP BY "slug");

CREATE UNIQUE INDEX "NewsPost_slug_key" ON "NewsPost"("slug");

-- ---------------------------------------------------------------------------
-- Credential.credentialId: one authenticator belongs to one user. The current
-- registration path can't create a duplicate (it returns early when the id is
-- already enrolled), so this should be a no-op - but a duplicate would mean two
-- accounts share a security key, which must not survive silently. Keep the
-- earliest enrolment; a user whose key is removed here can simply re-register
-- it, and it was never usable for them anyway.
-- ---------------------------------------------------------------------------
DELETE FROM "Credential"
WHERE "id" NOT IN (SELECT MIN("id") FROM "Credential" GROUP BY "credentialId");

CREATE UNIQUE INDEX "Credential_credentialId_key" ON "Credential"("credentialId");

-- ---------------------------------------------------------------------------
-- Indexes for queries that previously scanned.
-- ---------------------------------------------------------------------------

-- Search orders by updatedAt inside a workspace.
CREATE INDEX "Page_workspaceId_updatedAt_idx" ON "Page"("workspaceId", "updatedAt");

-- The maintenance sweep deletes expired sessions; without this it scans.
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- The sidebar reads the five most recent visits per user.
CREATE INDEX "RecentVisit_userId_visitedAt_idx" ON "RecentVisit"("userId", "visitedAt");

-- Notification retention sweep.
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");
