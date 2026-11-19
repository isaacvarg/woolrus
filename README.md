# Woolrus V2

Warehouse fulfillment for a WooCommerce shop: pull paid orders in, then pick, pack, QA, buy labels and ship.
Decisions and conventions: [docs/decisions.md](docs/decisions.md). Roadmap, module status and project rules:
[SPEC.md](SPEC.md). Requirements: [docs/srs.md](docs/srs.md).

## Layout

```
apps/web            Next.js: UI (PWA for floor tablets), oRPC API at /rpc and /api/v1, auth
apps/worker         pg-boss background jobs (sync, rates, WooCommerce push, label reconciliation)
packages/contracts  API contract: Zod schemas + oRPC procedures. Web and Android clients type against this.
packages/core       Domain logic, permissions, idempotency, audit. Every rule lives here.
packages/db         Prisma schema, migrations, seed, client
packages/i18n       en/es message catalogs; keys double as API error codes
packages/logger     pino wrapper
packages/config     shared tsconfig
docker/             Dockerfile (web, worker, migrate images), dev and prod compose files
```

## Getting started

Requires Node 24 and pnpm 12 (`mise install` sets both up) and Docker.

On NixOS, run `nix develop` first: `flake.nix` provides the Prisma engines, openssl and pkg-config (x86_64-linux
only). When you bump `prisma`, update the engine `commit` and `hash` in `flake.nix` to match.

```bash
pnpm install
```

```bash
cp .env.example .env
```

Then set `SETTINGS_ENCRYPTION_KEY` in `.env` (it encrypts integration secrets stored in Settings). Without it,
`/api/health` reports `encryption: "fail"` with a 503, and the e2e suite waits on that endpoint:

```bash
openssl rand -base64 32
```

```bash
pnpm stack:up
```

That starts Postgres (`:5442`), RustFS (`:9010`, console `:9011`) and a WooCommerce dev store at
<http://localhost:8090> (admin / admin), seeded with products and processing orders. Then:

```bash
pnpm db:migrate && pnpm db:seed
```

```bash
pnpm dev
```

Open <http://localhost:3000>. Sign-in is invite-only; emails listed in `ADMIN_EMAILS` (in `.env`) can always sign
in and become Admin. Without an email provider, the magic link is printed in the web server's log.

## Everyday commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Web and worker in watch mode |
| `pnpm lint` / `pnpm format` | Biome check / fix |
| `pnpm typecheck` | TypeScript across the repo |
| `pnpm test` | Unit and integration tests (integration tests use `TEST_DATABASE_URL`) |
| `pnpm --filter @woolrus/web test:e2e` | Playwright smoke tests (desktop + tablet) |
| `pnpm db:migrate` | Create/apply a migration after editing `packages/db/prisma/schema` |
| `pnpm db:studio` | Browse the database |
| `pnpm stack:up` / `pnpm stack:down` | Start / stop the dev stack (data is kept) |
| `docker compose -f docker/compose.dev.yml down -v` | Stop the dev stack and **delete its volumes** (Postgres, RustFS, WooCommerce) |

### Resetting the dev environment

Wipes all V2 dev data (the compose project is `woolrus-v2-dev`; v1's stack is untouched), then rebuilds it:

```bash
docker compose -f docker/compose.dev.yml down -v
pnpm stack:up
pnpm db:migrate && pnpm db:seed
pnpm dev
```

To reset only the database, keeping WooCommerce and RustFS: `pnpm --filter @woolrus/db exec prisma migrate reset`.

## Adding an endpoint

1. Add the procedure (input, output, route) to `packages/contracts`.
2. Implement the behaviour in `packages/core`, starting with `assertCan(actor, "<permission>")`.
3. Wire it in `apps/web/src/server/router.ts`, one line calling core.
4. Add any new error message keys to both catalogs in `packages/i18n`.

The REST/OpenAPI version appears at `/api/v1` and `/api/openapi.json` automatically.

## Deploying

Pushes to `main` publish images to GHCR as `:main`; a `v*` tag publishes `:<version>` and `:latest`. The
images are public, so the host needs no registry login. `docker/compose.prod.yml` is self-contained: on the host
(or in Arcane) it needs only a `.env` beside it, filled in from `docker/.env.prod.example`:

```bash
docker compose -f compose.prod.yml pull && docker compose -f compose.prod.yml up -d
```

### HTTPS on the internal network

Woolrus stays off the internet but still needs HTTPS: browsers only allow the microphone (voice memos) and
secure sign-in cookies on HTTPS pages. Use Nginx Proxy Manager with a Let's Encrypt **DNS challenge**, which
needs no inbound port:

1. Add a DNS A record, e.g. `woolrus.<your domain>`, pointing at the host's **internal** IP. If the router
   blocks public names that resolve to private addresses, add a local DNS override instead.
2. **SSL Certificates → Add Let's Encrypt:** the domain, tick **Use a DNS Challenge**, pick the DNS provider and
   give it an API token scoped to that zone.
3. **Hosts → Proxy Hosts → Add:** the domain, scheme `http`, forward to the host's IP on `WEB_PORT` (3000), with
   **Websockets** and **Block common exploits** on. On the SSL tab pick the certificate and turn on
   **Force SSL** and **HTTP/2**.
4. Set `BETTER_AUTH_URL=https://woolrus.<your domain>` in `.env` and use the same origin for the OAuth redirect
   URIs. GlitchTip (port 8000) can get its own proxy host the same way, with `GLITCHTIP_DOMAIN` to match.

Woo webhooks can't reach an internal-only host; the worker's scheduled sync picks up orders without them.
