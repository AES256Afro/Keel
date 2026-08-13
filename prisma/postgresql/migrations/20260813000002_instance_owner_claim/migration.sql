-- Preserve ownership only when an existing instance has exactly one distinct
-- workspace owner. Older releases could select a different operator through
-- KEEL_OWNER_EMAIL, which SQL migrations cannot read. Choosing the oldest of
-- several users would therefore grant the wrong account instance authority.
-- Multi-user upgrades deliberately remain unclaimed so the host operator can
-- use the verified legacy binding or the machine-confirmed claim flow.
INSERT INTO "AppSetting" ("key", "value", "updatedAt")
SELECT 'instance.ownerUserId', w."ownerId", CURRENT_TIMESTAMP
FROM "Workspace" w
WHERE NOT EXISTS (
  SELECT 1 FROM "AppSetting" WHERE "key" = 'instance.ownerUserId'
)
AND NOT EXISTS (
  SELECT 1 FROM "Workspace" other WHERE other."ownerId" <> w."ownerId"
)
ORDER BY w."createdAt" ASC, w."id" ASC
LIMIT 1;
