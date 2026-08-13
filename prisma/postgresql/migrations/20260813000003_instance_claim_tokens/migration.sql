-- Short-lived browser-authenticated tokens for the machine-local instance
-- claim command. Plaintext tokens are never stored.
CREATE TABLE "InstanceClaimToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InstanceClaimToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InstanceClaimToken_userId_key" ON "InstanceClaimToken"("userId");
CREATE UNIQUE INDEX "InstanceClaimToken_tokenHash_key" ON "InstanceClaimToken"("tokenHash");
CREATE INDEX "InstanceClaimToken_expiresAt_idx" ON "InstanceClaimToken"("expiresAt");

ALTER TABLE "InstanceClaimToken" ADD CONSTRAINT "InstanceClaimToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
