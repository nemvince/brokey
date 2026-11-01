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
bun run db:generate   # writes SQL migrations into ./drizzle
bun dev               # http://localhost:3000
```

| Variable        | Default              | Meaning                                                                     |
| --------------- | -------------------- | --------------------------------------------------------------------------- |
| `ADMIN_TOKEN`   | *(empty)*            | Bearer token for `/api/admin/*`. Empty disables the admin API (503).        |
| `DATABASE_PATH` | `./data/brokey.db`   | SQLite file. Existing migrations are applied on boot.                       |
| `PORT`          | `3000`               | HTTP port.                                                                  |

Production: `bun run start`. The working database lives in `data/`, which is
gitignored — that file is the security boundary, since provider secrets are stored
in it in plaintext.

## Using the proxy

1. Open `http://localhost:3000/admin` and sign in with `ADMIN_TOKEN`.
2. **Providers** → *Add provider*. `baseUrl` must include the API version prefix,
   for example `https://api.openai.com/v1` or `https://openrouter.ai/api/v1`.
   Paths from the client are appended after that prefix (`/v1/chat/completions`
   becomes `<baseUrl>/chat/completions`).
3. Add one or more API keys to the provider. Keys are tried least-recently-used
   first and cooled down automatically on 401/402/403/429/network failures.
4. *Fetch models* to sync the upstream catalog, choose which models to expose,
   and give each a public ID.
5. **Keys** → *Create key* to mint a client token (`sk-brokey-…`). The plaintext
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

## Development

```bash
bun run typecheck
bun test
```

`tests/` drives the HTTP surface against in-memory SQLite and a mock upstream.

Single Bun process only: limit checks and key cooldowns are not coordinated
across processes, so do not point two instances at one database file.
