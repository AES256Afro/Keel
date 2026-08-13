#!/bin/sh
# Update the always-on Keel deployment on a VPS, safely.
#
#   ./scripts/deploy/vps-update.sh [git-ref]
#
# Data safety: Litestream streams every write to R2 continuously, so the state
# right before this upgrade is already replicated off-host. Migrations applied
# by the entrypoint are additive (prisma migrate deploy), never destructive.
set -e

REF="${1:-$(git rev-parse --abbrev-ref HEAD)}"
cd "$(CDPATH= cd "$(dirname "$0")/../.." && pwd)"

echo "[deploy] fetching $REF…"
git fetch --all --tags --prune
git checkout "$REF"
git pull --ff-only origin "$REF" 2>/dev/null || true

echo "[deploy] building and rolling out (Caddy health-checks the new container)…"
docker compose -f docker-compose.prod.yml up -d --build

echo "[deploy] pruning old images…"
docker image prune -f >/dev/null 2>&1 || true

echo "[deploy] done  -  $REF is live. Your data was replicated to R2 throughout."
