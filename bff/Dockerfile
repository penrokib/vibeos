# rokibrain BFF — NestJS 11 (port 4000)
# Channels Dewx apps/core/platform/Dockerfile pattern.

FROM node:22-alpine AS builder
WORKDIR /app

# Yarn 4 needs the .yarn cache + .yarnrc.yml to install at build time.
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/ .yarn/
COPY tsconfig.base.json ./
COPY turbo.json ./

# Workspace manifests — Yarn 4 immutable needs ALL workspace package.json
# files present so the lockfile graph matches root yarn.lock exactly.
COPY packages/auth/package.json packages/auth/
COPY packages/database/package.json packages/database/
COPY apps/bff/package.json apps/bff/
COPY apps/web/package.json apps/web/
COPY apps/extension/package.json apps/extension/
COPY apps/desktop/package.json apps/desktop/

# Install dependencies for the BFF subtree
RUN corepack enable && yarn install --immutable

# Copy sources
COPY packages/ packages/
COPY apps/bff/ apps/bff/

RUN yarn workspace @vibeos/database run db-generate && \
    yarn workspace @vibeos/database build && \
    yarn workspace @vibeos/auth build && \
    yarn workspace @vibeos/bff build

# --- Runner ---
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000

COPY --from=builder /app/apps/bff/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages

EXPOSE 4000
CMD ["node", "--max-old-space-size=1024", "dist/main.js"]
