# syntax=docker/dockerfile:1

# ---- build stage: install deps, then emit one self-contained executable ----
FROM oven/bun:1 AS build
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
FROM debian:stable-slim AS runtime

COPY --from=build /app/dist/brokey /usr/local/bin/brokey
RUN mkdir -p /data && chown 10001:10001 /data

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/brokey.db

USER 10001:10001
EXPOSE 3000
VOLUME ["/data"]

ENTRYPOINT ["/usr/local/bin/brokey"]
