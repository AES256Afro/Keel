# Keel - production image.
#
# One image for every container host: Docker Compose on a VPS, Azure Container
# Apps, AWS App Runner / ECS, DigitalOcean App Platform, Fly, Railway, Render.
# It works with SQLite on a mounted volume or with PostgreSQL over the network -
# the entrypoint picks the migration set from DATABASE_URL.
#
#   docker build -t keel .
#   docker run -p 3000:3000 -v keel-data:/data keel
#
# Multi-stage, so the runtime image carries no compilers, no dev dependencies
# and no source - and runs as a non-root user.

# ----------------------------------------------------------------- deps -----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update -qq \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
# --ignore-scripts: the postinstall hook runs `prisma generate`, which must wait
# until the build stage has resolved which provider this image is for.
RUN npm ci --no-audit --no-fund --ignore-scripts

# ---------------------------------------------------------------- build -----
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update -qq \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The Prisma client is generated for exactly one provider, so an image is built
# for one. Default SQLite; pass --build-arg DB_PROVIDER=postgresql for managed
# Postgres (Azure Database, RDS, Neon, Supabase…).
ARG DB_PROVIDER=sqlite
ENV NEXT_TELEMETRY_DISABLED=1
RUN node scripts/db-provider.mjs "${DB_PROVIDER}" \
    && node scripts/sync-postgres-schema.mjs \
    && npx prisma generate \
    && npx next build

# -------------------------------------------------------------- runtime -----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update -qq \
    && apt-get install -y --no-install-recommends openssl ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*

ARG DB_PROVIDER=sqlite
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    KEEL_DB_PROVIDER=${DB_PROVIDER} \
    DATABASE_URL="file:/data/keel.db" \
    KEEL_BACKUP_DIR=/data/backups \
    NOPIN_UPLOAD_DIR=/data/uploads

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# The database and backups live on the volume; the app directory never changes
# at runtime, so a host can mount it read-only if it wants to.
RUN mkdir -p /data/backups && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 3000

# /api/health is unauthenticated and touches no database, so an orchestrator can
# probe it without a session and without waking the connection pool.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" | grep -q '"ok":true' || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
