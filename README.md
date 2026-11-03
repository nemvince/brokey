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

OpenCode free providers add optional variables; every one has a working default:

| Variable                      | Default                                                | Meaning                                                               |
| ----------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------- |
| `BROKEY_OPENCODE_CATALOG_URL` | `https://models.opencode.ai/api.json`                  | Model catalog the free tier is described by.                          |
| `BROKEY_OPENCODE_UPDATE_API`  | `https://opencode.ai/update/api`                       | Release handshake; the derived identity follows it.                   |
| `BROKEY_OPENCODE_SOURCE_BASE` | `https://raw.githubusercontent.com/anomalyco/opencode` | Raw source root used to derive the session-id recipe.                 |
| `BROKEY_OPENCODE_ATOM_URL`    | `https://github.com/anomalyco/opencode/releases.atom`  | Fallback release feed.                                                |
| `BROKEY_OPENCODE_CHANNEL`     | `latest`                                               | Release channel.                                                      |
| `BROKEY_OPENCODE_UPDATE_MODE` | `reactive`                                             | `always` adopts every release; `reactive` waits for a gate rejection. |
| `BROKEY_OPENCODE_USER_AGENT`  | _(derived)_                                            | Pins the identity and disables derivation entirely.                   |
| `BROKEY_OPENCODE_CHAT_URL`    | _(from catalog)_                                       | Pins the inference root, for example for a mock gateway.              |

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
chose to expose. Each entry carries the metadata clients use for context
budgeting: `name`, `context_length` (the context window) and `max_output_tokens`
where known. Those values are seeded from the provider on sync and can be
overridden per model in the GUI. Every other `/v1/*` path is proxied.

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

## OpenCode free providers

A provider created with **Type: OpenCode free** proxies the OpenCode free tier,
which has no account and no API key. Its allowance is metered per egress IP, and
its gateway only answers requests shaped like its own CLI, so brokey reproduces
that shape:

- a derived `opencode/<channel>/<version>/cli` User-Agent, refreshed from the
  same update endpoint the CLI polls;
- a session header carrying a freshly minted `ses_…` id, stable per client
  conversation so upstream prompt caching still applies;
- the `read`/`shell` tool definitions, with a client's own tool of the same name
  renamed so both survive;
- an `<env>` block in the system prompt, and an output-token floor so a
  reasoning model cannot spend the whole budget thinking.

Upstream is always called with `stream: true` and the answer is reshaped, so both
streaming and non-streaming clients work. Only `POST /v1/chat/completions` is
supported; model lists come from the OpenCode catalog (`Fetch models` syncs only
the free, non-deprecated, tool-callable entries), and a family shorthand such as
`mimo` selects that family's synced free model.

Each OpenCode provider owns an **egress pool**: a strategy (`round-robin`,
`failover`, `random`), a list of HTTP forward proxies, and optionally this host as
a `direct` entry. A refused or throttled egress is cooled down with exponential
backoff and the request is rotated to the next one; a relay URL can be configured
to forward the whole attempt elsewhere. Proxy credentials are stored but never
returned by the admin API.

`scripts/egress-proxy.ts` is a ready-made forward proxy for those entries:

```bash
PORT=8888 EGRESS_PROXY_TOKEN=secret bun scripts/egress-proxy.ts
# then add http://user:secret@host:8888 as an egress entry and press "Test all"
```

The provider detail page shows the derived identity, the gate state (open,
throttled, or IP-blocked) with the last rejection's log id, and a per-entry probe
result including that egress's public address.

## Statistics

`http://localhost:3000/` is a no-auth dashboard: total tokens, requests, prompt
vs completion split, average completion size, per-model token shares and a
traffic chart — numbers only. The same data is available as JSON at
`/api/stats?range=24h|7d|30d|all`.

The endpoint is unauthenticated, so it deliberately emits no identifying data:
no provider names, no client key names or prefixes, no per-request rows (no
endpoints, latencies, status codes or request IDs). Provider and key identities
live in the authenticated Usage page (`/admin/usage`) instead.

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
