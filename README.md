# brokey

A self-hosted, OpenAI-compatible proxy. You define providers and their upstream
model catalogs, attach several API keys per provider with automatic failover when
one is rate-limited or exhausted, and issue client keys with request/token limits.
Every proxied call is logged, and the front page is a public statistics dashboard.

## Setup

```bash
bun install
cp .env.example .env
# edit .env and set a long random ADMIN_TOKEN
bun run db:generate   # writes SQL migrations into ./drizzle and embeds them
bun dev               # http://localhost:3000
```

| Variable        | Default            | Meaning                                                              |
| --------------- | ------------------ | -------------------------------------------------------------------- |
| `ADMIN_TOKEN`   | _(empty)_          | Bearer token for `/api/admin/*`. Empty disables the admin API (503). |
| `DATABASE_PATH` | `./data/brokey.db` | SQLite file. Existing migrations are applied on boot.                |
| `PORT`          | `3000`             | HTTP port.                                                           |

Production: `bun run start`, or a single binary (below). The working database
lives in `data/`, which is gitignored — that file is the security boundary, since
provider secrets are stored in it in plaintext.

## Using the proxy

1. Open `http://localhost:3000/admin` and sign in with `ADMIN_TOKEN`.
2. **Providers** → _Add provider_. `baseUrl` must include the API version prefix,
   for example `https://api.openai.com/v1` or `https://openrouter.ai/api/v1`.
   Paths from the client are appended after that prefix (`/v1/chat/completions`
   becomes `<baseUrl>/chat/completions`).
3. Add one or more API keys to the provider. Keys are tried least-recently-used
   first and cooled down automatically on 401/402/403/429/network failures.
4. _Fetch models_ to sync the upstream catalog, choose which models to expose,
   and give each a public ID.
5. **Keys** → _Create key_ to mint a client token (`sk-brokey-…`). The plaintext
   token is shown once. Optionally cap requests and/or tokens per `total`, `day`,
   or `month` (UTC) window.
6. Point any OpenAI client at the proxy:

```bash
curl -s http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-brokey-xxxxxxxx" \
  -H "content-type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}]}'
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3000/v1", api_key="sk-brokey-xxxxxxxx")
print(client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "hello"}],
).choices[0].message.content)
```

`GET /v1/models` and `GET /v1/models/<publicId>` are answered from the local
enabled catalog rather than passed through, so clients only ever see models you
chose to expose. Every other `/v1/*` path is proxied.

Routing a request:

- with a JSON body, the `model` field is matched against public model IDs and
  rewritten to the provider's upstream ID before forwarding;
- otherwise select a provider with the `x-brokey-provider: <name>` header or
  `?provider=<name>`; a single enabled provider is used automatically.

Multipart and other non-JSON bodies (for example audio transcription) cannot be
model-rewritten — the body is forwarded unchanged and the provider is selected by
header, query, or the sole enabled provider.

Responses carry `x-brokey-request-id`, and limited client keys also get
`x-brokey-requests-remaining` / `x-brokey-tokens-remaining`.

## Statistics

`http://localhost:3000/` is a no-auth dashboard (requests, tokens, per-model,
per-provider, per-client-key breakdowns and the latest requests). The same data
is available as JSON at `/api/stats?range=24h|7d|30d|all`.

## Building a single binary

```bash
bun run build      # → dist/brokey
ADMIN_TOKEN=… ./dist/brokey
```

`bun run build` runs `scripts/embed-migrations.ts` (which copies
`drizzle/*/migration.sql` into `src/server/migrations.generated.ts`) and then
`bun build --compile`. The executable contains the Bun runtime, the React
frontend and every migration, so it needs no `node_modules`, no `drizzle/`
folder and no Bun install on the target host. Only `DATABASE_PATH` has to point
at a writable directory.

The binary targets the platform that built it, so run it on the same OS and libc:
`bun run build` on a glibc distro yields a glibc binary, and the Docker image
builds it inside Alpine for musl. Pass `--target` (for example
`bun build src/index.ts --compile --target=bun-linux-arm64-musl`) to copy the
build for another platform; musl binaries need `libstdc++` on the host.

Rebuild whenever migrations change; `bun run db:generate` regenerates the
embedded module for you, and `bun run build` always does it before compiling.

## Docker

```bash
docker build -t brokey .
docker run -d -p 3000:3000 \
  -e ADMIN_TOKEN="$(openssl rand -hex 32)" \
  -v brokey-data:/data \
  brokey
```

The image is a two-stage build: `oven/bun:1-alpine` compiles the binary natively
for musl, then it is copied into `alpine:3.22` (+ `libstdc++`) running as an
unprivileged user (uid 10001). About 110 MB on disk, nearly all of it the Bun
runtime; the database file lives on the `/data` volume.

Because the build stage is Alpine-native, `docker buildx build --platform
linux/arm64` produces a genuine arm64 image — the build itself runs under
emulation unless the builder is arm64.

## Development

```bash
bun run fmt        # bun fmt, config in bunfig.toml
bun run typecheck
bun test
```

`tests/` drives the HTTP surface against in-memory SQLite and a mock upstream.

Single Bun process only: limit checks and key cooldowns are not coordinated
across processes, so do not point two instances at one database file.
