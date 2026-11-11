# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — install production dependencies
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS deps

WORKDIR /app

# sqlite3 ships prebuilt N-API binaries, but keep a toolchain available as a
# fallback in case a binary has to be compiled for the target platform.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — runtime image
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="LLM Data Curation" \
      org.opencontainers.image.description="Knowledge Base Curation Suite for building LLM training data" \
      org.opencontainers.image.source="https://github.com/SyntaxMasons/LLMDataCuration"

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/database.sqlite

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server.mjs ai.mjs db.mjs ./
COPY views ./views

# SQLite lives on a volume so data survives container upgrades.
RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "server.mjs"]
