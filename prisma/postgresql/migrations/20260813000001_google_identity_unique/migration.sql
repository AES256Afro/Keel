-- A Google subject identifies one account. The callback already fails closed
-- when it sees an ambiguous legacy state, but only a database constraint can
-- arbitrate two callbacks that try to link the same subject concurrently.
--
-- A pre-constraint race could have left duplicate links. Choosing a winner or
-- clearing a link here could lock a Google-only account out, so stop with a
-- diagnostic that tells the instance owner what must be resolved.
DO $google_identity_unique$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "User"
    WHERE "googleId" IS NOT NULL
    GROUP BY "googleId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Keel migration blocked: duplicate non-null User.googleId links exist. Resolve duplicate links before upgrading.';
  END IF;
END;
$google_identity_unique$;

CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");
