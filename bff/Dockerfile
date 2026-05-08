# vibeos BFF — NestJS 11 (port 4000)
# Multi-stage build: builder → runtime
# Rebranded from rokibrain pattern for vibeos.app Scaleway k3s deploy.
#
# Build context MUST be the monorepo root (not bff/):
#   docker build -f bff/Dockerfile .

# ─────────────────────────────────────────────────────────────
# Stage 1: builder
# ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

# .yarnrc.yml uses enableGlobalCache + nodeLinker: node-modules.
# No local .yarn cache dir — corepack will fetch the pinned Yarn version.
COPY package.json yarn.lock .yarnrc.yml ./
COPY tsconfig.base.json ./

# Workspace manifests — Yarn 4 --immutable needs ALL workspace package.json
# files present so the lockfile graph matches root yarn.lock exactly.
COPY packages/database/package.json packages/database/
COPY packages/auth/package.json       packages/auth/
COPY bff/package.json                 bff/
# desktop + sdk + plugins required for lockfile graph resolution
COPY desktop/package.json             desktop/
COPY sdk/package.json                 sdk/
# plugins (glob workspace) — copy manifests without sources
COPY plugins/                         plugins/

RUN corepack enable && yarn install --immutable

# Copy full sources for packages + bff (desktop/sdk excluded — not needed)
COPY packages/ packages/
COPY bff/      bff/

# Generate Prisma client → build shared packages → build BFF
RUN yarn workspace @vibeos/database run db-generate && \
    yarn workspace @vibeos/database build          && \
    yarn workspace @vibeos/auth build              && \
    yarn workspace @vibeos/bff build

# ─────────────────────────────────────────────────────────────
# Stage 2: runtime  (lean image, no dev toolchain, no src)
# ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000

# Wholesale node_modules copy (Yarn 4 node-modules linker; deterministic).
# Packages/ is needed for workspace symlinks and Prisma generated client.
COPY --from=builder /app/node_modules  ./node_modules
COPY --from=builder /app/packages      ./packages
COPY --from=builder /app/bff/dist      ./dist

# Non-root user for k8s Pod security context
RUN addgroup -S vibeos && adduser -S vibeos -G vibeos
USER vibeos

EXPOSE 4000

# Lightweight liveness probe. Hits /health which is @Public() and returns
# { status: "ok" } without touching the database — graceful degrade guaranteed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:4000/health || exit 1

CMD ["node", "--max-old-space-size=512", "dist/main.js"]
