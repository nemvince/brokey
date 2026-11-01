# syntax=docker/dockerfile:1

# ---- build stage: install deps, then emit one self-contained executable ----
# The Alpine-based Bun image compiles for musl natively, so no cross-compile
# download is needed and multi-arch builds stay native.
FROM oven/bun:1-alpine AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json drizzle.config.ts ./
COPY drizzle ./drizzle
COPY scripts ./scripts
COPY src ./src

# Embeds drizzle migrations and bundles the React frontend into dist/brokey.
RUN bun run build

# ---- runtime stage: the binary only — no Bun, no node_modules ----
FROM alpine:3.22 AS runtime

# Bun's musl build links libstdc++; nothing else is needed.
RUN apk add --no-cache libstdc++ \
  && addgroup -S -g 10001 brokey \
  && adduser -S -u 10001 -G brokey brokey \
  && mkdir -p /data \
  && chown brokey:brokey /data

COPY --from=build /app/dist/brokey /usr/local/bin/brokey

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/brokey.db

USER brokey
EXPOSE 3000
VOLUME ["/data"]

ENTRYPOINT ["/usr/local/bin/brokey"]
