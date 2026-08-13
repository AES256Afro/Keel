#!/bin/sh
# Keel container entrypoint: restore → migrate → serve.
#
# Works for both database backends:
#   DATABASE_URL=file:/data/keel.db   SQLite on a mounted volume. When
#                                      LITESTREAM_R2_* is configured, the
#                                      database is restored from the replica on
#                                      a fresh host and streamed off-site while
#                                      serving.
#   DATABASE_URL=postgresql://…        Managed Postgres (Azure, RDS, Neon…).
#                                      Litestream does not apply - durability is
#                                      the provider's job.
set -e

case "${DATABASE_URL:-}" in
  postgres://*|postgresql://*) PROVIDER=postgresql ;;
  file:*)                      PROVIDER=sqlite ;;
  "") echo "[keel] DATABASE_URL is not set" >&2; exit 1 ;;
  *)  echo "[keel] DATABASE_URL must start with file: or postgresql:" >&2; exit 1 ;;
esac
echo "[keel] database: $PROVIDER"

# Fail fast on a misbuilt image rather than at the first query: the Prisma
# client is generated for one provider, so a mismatch is a deploy-time error.
BUILT_FOR="${KEEL_DB_PROVIDER:-sqlite}"
if [ "$BUILT_FOR" != "$PROVIDER" ]; then
  echo "[keel] this image was built for $BUILT_FOR but DATABASE_URL is $PROVIDER." >&2
  echo "[keel] rebuild with: docker build --build-arg DB_PROVIDER=$PROVIDER ." >&2
  exit 1
fi

R2_READY=""
if [ "$PROVIDER" = "sqlite" ]; then
  # DATABASE_URL is a URL, not a path: Prisma accepts `file:/data/keel.db`,
  # `file:///data/keel.db`, and query parameters like `?connection_limit=1`
  # (the standard advice for "database is locked"). Everything below - the
  # mkdir, the litestream.yml rendering, the exists-check that gates the
  # restore, the replicate target - needs the actual filename. Stripping only
  # the scheme made Litestream restore into and replicate a literal
  # `/data/keel.db?connection_limit=1` while Prisma read /data/keel.db: every
  # real write went unreplicated, and every boot "restored" a file the app
  # never opens. Strip the query string too, and collapse a `file://`-style
  # authority prefix down to a single leading slash.
  DB="${DATABASE_URL#file:}"
  DB="${DB%%\?*}"
  while [ "${DB#//}" != "$DB" ]; do DB="${DB#/}"; done
  mkdir -p "$(dirname "$DB")" "${KEEL_BACKUP_DIR:-/data/backups}"

  if [ -n "${LITESTREAM_R2_BUCKET:-}" ] && [ -n "${LITESTREAM_R2_ACCESS_KEY_ID:-}" ]; then
    if command -v litestream >/dev/null 2>&1; then
      R2_READY=1
    else
      echo "[keel] LITESTREAM_R2_* is set but litestream is not in this image;" >&2
      echo "[keel] build with Dockerfile.prod for continuous replication." >&2
    fi
  fi

  if [ -n "$R2_READY" ]; then
    # The shipped litestream.yml is a template: its db path must match the
    # database DATABASE_URL actually names, or replication guards a file the
    # app never writes. Render the effective config with the real path.
    LITESTREAM_CONFIG=/tmp/litestream.yml
    sed "s|^\([[:space:]]*- path:\).*|\1 $DB|" /app/litestream.yml > "$LITESTREAM_CONFIG"

    # Disaster recovery: no local database but a replica exists → pull it back.
    # -if-replica-exists already exits 0 when the bucket holds no generation,
    # so a non-zero exit is a real failure (credentials, network). Continuing
    # would create an empty database and replicate it over the newest good
    # generation - abort instead; booting nothing is strictly better.
    if [ ! -f "$DB" ]; then
      echo "[keel] no local database - attempting Litestream restore from R2…"
      if ! litestream restore -if-replica-exists -config "$LITESTREAM_CONFIG" -o "$DB" "$DB"; then
        echo "[keel] Litestream restore failed - check LITESTREAM_R2_* and connectivity" >&2
        exit 1
      fi
      [ -f "$DB" ] || echo "[keel] no replica found yet - starting from an empty database"
    fi
  fi

  # Baseline seam for databases that did not grow up under the Prisma CLI.
  #
  # Every non-Docker install is self-migrated: ensureSchema (the in-app
  # migrator) bootstraps the schema and records history only in
  # `_keel_migrations` - `_prisma_migrations` never exists there. When such a
  # database arrives here (`keel to-docker` copies it into the volume, or an
  # operator copies it by hand), `prisma migrate deploy` refuses it outright
  # with P3005 "the database schema is not empty": it would otherwise replay
  # 0_init against existing tables. Under `set -e` and
  # `restart: unless-stopped` that refusal is a crash loop on the very first
  # boot - the advertised migration path dead on arrival.
  #
  # The fix is Prisma's own baselining tool: `prisma migrate resolve
  # --applied <name>` records a migration as already applied (creating
  # `_prisma_migrations` with proper checksums) without running it. We resolve
  # exactly the set the self-migrator recorded in `_keel_migrations`, then let
  # `migrate deploy` apply anything genuinely newer - so a database copied out
  # of an older CLI install still picks up migrations this image ships.
  #
  # The same step covers a database carrying BOTH ledgers (it lived in a CLI
  # install after leaving Docker, where ensureSchema self-applied newer
  # migrations): those get adopted into `_prisma_migrations` too, so deploy
  # never replays work the self-migrator already did. Together with
  # ensureSchema's mirror rule (it adopts `_prisma_migrations` history when
  # the CLI ledger is behind), each migrator recognises the other's records -
  # never two writers, in either direction.
  if [ -f "$DB" ]; then
    BASELINE="$(node -e '
      const { PrismaClient } = require("@prisma/client");
      const p = new PrismaClient();
      (async () => {
        // No SQL string literals here (sh single-quoting): fetch names and
        // filter in JS instead.
        const master = await p.$queryRawUnsafe("SELECT name, type FROM sqlite_master");
        const tables = new Set(master.filter((r) => r.type === "table").map((r) => r.name));
        if (!tables.has("User")) return; // fresh file - deploy creates everything
        if (!tables.has("_keel_migrations")) {
          if (!tables.has("_prisma_migrations")) {
            console.error("[keel] this database has tables but no migration history at all;");
            console.error("[keel] prisma migrate deploy will refuse it (P3005). If it came from");
            console.error("[keel] prisma db push, baseline it once with prisma migrate resolve.");
          }
          return; // CLI-managed (or unbaselinable) - nothing to adopt
        }
        const applied = new Set(
          tables.has("_prisma_migrations")
            ? (
                await p.$queryRawUnsafe(
                  "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL"
                )
              ).map((r) => r.migration_name)
            : []
        );
        const rows = await p.$queryRawUnsafe("SELECT name FROM _keel_migrations ORDER BY name");
        for (const r of rows) if (!applied.has(r.name)) console.log(r.name);
      })().finally(() => p.$disconnect());
    ')"
    if [ -n "$BASELINE" ]; then
      echo "[keel] self-managed migration history found - baselining into _prisma_migrations…"
      for m in $BASELINE; do
        if [ -d "/app/prisma/migrations/$m" ]; then
          npx prisma migrate resolve --applied "$m" --schema /app/prisma/schema.prisma >/dev/null
          echo "[keel]   resolved $m as applied"
        else
          # Recorded by a newer (or different) install than this image ships.
          # Not resolvable here; deploy below will not try to run it either.
          echo "[keel]   note: recorded migration $m is not shipped in this image - skipping" >&2
        fi
      done
    fi
  fi
fi

# Additive migrations, chosen per dialect. Never destructive.
echo "[keel] applying migrations…"
node scripts/deploy-migrations.mjs

if [ -n "$R2_READY" ]; then
  echo "[keel] serving under Litestream replication to R2"
  exec litestream replicate -config "$LITESTREAM_CONFIG" -exec "node scripts/start.mjs"
fi

exec node scripts/start.mjs
