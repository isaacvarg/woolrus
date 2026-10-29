# Spec: `operations`

**Milestone:** M4 · **Depends on:** — (runs alongside; reads `settings`, pings `store-sync`, extends the health
entries `notes`, `identity` and `carriers` added) · **Used by:** every module (error capture, log bindings) ·
**State:** planned · **Issue:** [#29](https://github.com/isaacvarg/woolrus/issues/29)

Project-wide commands, structure, code style, testing levels and boundaries are in [`../../SPEC.md`](../../SPEC.md);
this spec only adds what is specific to `operations`.

## Objective

Make Woolrus safe to run unattended in production: errors reach someone, every log line can be traced to a
request, order or job, a broken dependency or a dead worker shows up in health, a job that gave up is visible and
can be retried, and customer personal data doesn't stay forever.

- **SRS:** NFR-OPS-01 (structured logs with request and order IDs), NFR-OPS-02 (error tracking and health checks),
  NFR-SEC-06 (PII retention and purge), NFR-REL-03 (the dead-letter view half; the durable queue exists).
  NFR-OPS-03/04 are already met (images, compose); this module only adds healthchecks to them.
- **Users:** Admins (failed-jobs page, retention setting, GlitchTip). The person running the host (health,
  container status). Indirectly everyone: fewer silent failures.
- **Go-live:** the checklist line "health checks green for database, storage, WooCommerce and every enabled
  shipping provider; GlitchTip receiving errors" is this module's exit test.

### What PII means here

Personally identifiable information: the customer's name, email, phone and street address, and anything that
repeats them. In Woolrus it sits on `Order` (name, email, addresses, ship-to, customer note), in `rawPayload`,
in inbound webhook payloads, in audit `before`/`after` snapshots, in idempotency replay records, and on label PDFs
and note photos in storage. Order numbers, items, weights, costs and tracking numbers are not PII on their own.

### User stories

1. As an admin, when the app throws on the server, in the worker or in a tablet's browser, the error appears in
   GlitchTip with the request, order or job it happened in, and without the customer's name or address.
2. As the person running the host, `/api/health` tells me whether the database, storage, encryption key,
   WooCommerce, email, every enabled shipping provider and the worker are working, and `docker compose ps` shows
   web and worker healthy or not.
3. As an admin, I see the background jobs that failed for good (a label purchase, a Woo push, an email), why, and
   for which order, and I can retry or dismiss each one.
4. As an admin, I set a retention period in Settings. Orders shipped or cancelled longer ago than that lose the
   customer's name, email, phone and street address; state, ZIP and country stay for metrics, and everything
   operational stays: items, packages, labels and their PDFs, costs, tracking, notes and photos, the timeline.
5. As a developer, I can follow one request or one order through web and worker logs by `requestId` /
   `orderId`, and the logs never contain secrets or customer PII.

## Scope

**In:**
- GlitchTip (Sentry SDK) in web (server and browser) and worker, PII scrubbed.
- Log coverage: request and job log lines with ids, `x-request-id` echoed, `AuditEvent.requestId` filled, PII
  added to the logger's redaction.
- Health: WooCommerce and worker entries; a worker heartbeat; container healthchecks for web and worker.
- Failed-jobs admin page with retry and dismiss.
- PII anonymization job, its guards in store-sync, an "anonymized" state in the order UI, a CLI dry run.
- Nightly Postgres backups in production and a rehearsed restore runbook (the go-live checklist line).

**Out:**
- Backing up object storage (label PDFs, photos): the host's own backup covers the `storage` volume; the runbook
  says so. Copying backups off the host is the operator's job, also in the runbook.
- Source-map upload to GlitchTip (decision 7).
- Performance tracing / APM (`tracesSampleRate` stays 0), uptime alerting, log shipping. GlitchTip's own alert
  emails cover "someone gets told".
- Deleting files on anonymization: label PDFs and note photos are kept (decision 2).
- Lumexia health: arrives with `lumexia`, using the pattern below.
- Staff PII (session IPs, user emails): users are deactivated, not purged (SPEC-identity).

## Design

### Error tracking (GlitchTip)

GlitchTip speaks the Sentry protocol, so the apps use the Sentry SDKs: **`@sentry/nextjs`** in `apps/web` and
**`@sentry/node`** in `apps/worker` (two new dependencies, approved with this spec). Versions are pinned like
every other dependency; check `@sentry/nextjs` supports Next 16.4 before adding it, and read
`apps/web/node_modules/next/dist/docs/` on `instrumentation.ts` / `instrumentation-client.ts` first.

- **Off unless configured.** `SENTRY_DSN` empty → the SDK isn't initialised and nothing is sent. Dev and test run
  without it.
- **Runtime DSN, not build time.** Images are built once in CI and deployed anywhere, so the browser can't use a
  `NEXT_PUBLIC_` DSN baked in at build. The root layout (server) reads `SENTRY_DSN` and renders an
  `<ErrorReporting>` client component that initialises the browser SDK on mount. `NEXT_PUBLIC_SENTRY_DSN` is
  removed from `.env.example`. Errors before hydration aren't captured; that's accepted.
- **Tunnel.** The browser SDK sends to `POST /api/errors` (the SDK's `tunnel` option), not to GlitchTip directly:
  tablets never need to reach the GlitchTip host, and ad blockers don't drop it. The route forwards an envelope
  only when its DSN matches the configured one (host and project id), so it isn't an open relay; it caps the body
  at 1 MB and answers 204 either way. No session needed (errors on the sign-in page count too).
- **Scrubbing.** `sendDefaultPii: false`. A shared `beforeSend` drops request bodies, cookies and the
  `authorization` header, and replaces the values of PII keys anywhere in `extra`/`contexts` with `[redacted]`
  (`customerName`, `customerEmail`, `email`, `phone`, `first_name`, `last_name`, `address_1`, `address_2`,
  `shippingAddress`, `billingAddress`, `shipTo`, `shipToOriginal`, `customerNote`). The key list is exported from
  `@woolrus/logger` so logs and errors redact the same things.
- **Context.** Tags: `service` (web / worker), `requestId`, `userId` (an id, not an email), `stationId`,
  `orderId`, `queue`, `jobId`. `release` = `WOOLRUS_VERSION`, `environment` = `SENTRY_ENVIRONMENT` (default
  `NODE_ENV`).
- **What gets captured:**
  - web: the `mapErrors` branch that already logs "unhandled API error" (non-`AppError`, non-`ORPCError`);
    route-handler and server-component errors through `onRequestError` in `instrumentation.ts`; client render
    errors through `app/global-error.tsx` and `(app)/error.tsx`. `AppError`s (expected, translated) are never sent.
  - worker: a job's error on its **final** attempt (`isFinalAttempt`), so a retry that succeeds makes no noise;
    `boss.on("error")`; `uncaughtException` / `unhandledRejection` (captured, flushed, then the process exits as
    today).
- No source-map upload (decision 7): browser stack traces are minified until it's added after go-live.

### Logging (NFR-OPS-01)

`@woolrus/logger` stays the only logger. Changes:

- **Redaction** gains the PII keys above (as `*.key` and `*.*.key` paths) next to the existing secret paths.
- **Requests:** `requestContext` already creates `requestId`. Web also sets the `x-request-id` response header to
  it, and logs one line per `/rpc` and `/api/v1` call when it finishes: `procedure`, `status`, `durationMs`,
  `requestId`, `userId`. `info` for 2xx–4xx, `error` for 5xx.
- **Audit:** `Actor` gains an optional `requestId`; `resolveActor` sets it and `recordAudit` writes it to
  `AuditEvent.requestId` (the column exists and is always null today), so an audit row leads to its log lines.
- **Jobs:** one wrapper in the worker, `runJob(queue, handler)`, used by every `boss.work`: binds `queue`,
  `jobId`, `attempt` and `orderId` (when the payload has one), logs start at `debug` and the outcome with
  `durationMs` at `info`, a failure at `warn` (will retry) or `error` (final, also sent to GlitchTip).
- **Not logs:** `apps/worker/src/cli.ts` prints results for a person at a terminal; its `console.*` stays. No
  `console.*` anywhere else in `apps/*/src` or `packages/*/src` (enforced by a Biome rule, `noConsole`, with the
  CLI file excepted).

### Health (`apps/web/src/app/api/health/route.ts`)

Existing: `database`, `encryption`, `storage` decide `ok` (503 when any fails); `email` is informational;
providers and fake providers make it `degraded`. Added:

| Entry | Values | Effect |
|---|---|---|
| `woocommerce` | `ok`, `fail`, `unconfigured` | `fail` → `degraded`. Calls `store.ping()` (the store-sync adapter) with a 3 s timeout. The result is cached in memory for 30 s, so the public endpoint can't be used to hammer the store. |
| `worker` | `ok`, `stale` | `stale` → `degraded`. `stale` when the last heartbeat is older than 3 minutes or there is none. |

Both are `degraded`, not down: the floor keeps working on a broken store or a stopped worker, and the web
container mustn't be marked unhealthy for another container's problem. The endpoint stays public and says only
`ok`/`fail` per entry, never an error message or a host.

**Worker heartbeat.** A new queue `ops.heartbeat`, scheduled every minute. Its handler upserts the row
`service_heartbeats('worker')` with `beatAt` and `version`, and touches `/tmp/worker-heartbeat`. Running it as a
job (not a timer) proves the worker is consuming the queue, not just alive.

**Containers.** The `web` image already has a `HEALTHCHECK` on `/api/health`. The `worker` image gets
`HEALTHCHECK --interval=60s CMD find /tmp/worker-heartbeat -mmin -3 | grep -q .`. `compose.prod.yml` gains no
duplicate checks; it gets `restart: unless-stopped` (already there). `docker compose ps` shows both.

### Failed jobs (NFR-REL-03)

pg-boss keeps a job in state `failed` once its retries are exhausted, until its retention (pg-boss's
`deleteAfterSeconds`, default 7 days) removes it. Set `deleteAfterSeconds` to 30 days in `queueOptions` for every
queue, so a failure over a long weekend is still there on Monday.

- `listFailedJobs(db, actor, { queue?, cursor? })` reads `pgboss.job` where `state = 'failed'` with raw SQL
  (pg-boss's schema, not Prisma's), newest first, 50 a page: `id`, `queue`, `createdOn`, `completedOn` (failed
  at), `retryCount`, the error message from `output`, and a **summary of the payload, never the payload**:
  `orderId` (linked to the order), `reason`, or for `email.send` the template name only (its payload holds the
  recipient's address).
- `retryFailedJob` calls pg-boss `retry(queue, id)`; `dismissFailedJob` calls `deleteJob(queue, id)`. Both are
  audited (`entityType: "Job"`). Retrying is safe because every handler is idempotent already (labels by
  idempotency key, emails by `Idempotency-Key`, sync by refetch).
- Permission `ops.jobs` (Admin only). Contract `packages/contracts/src/operations.ts`: `jobs.failed.list`,
  `jobs.failed.retry`, `jobs.failed.dismiss`.
- UI: `/jobs` under the admin part of the nav: a table (queue, failed at, attempts, error, order link) with Retry
  and Dismiss, and a count badge on the nav item when any exist. Strings in en and es.

### PII anonymization (NFR-SEC-06)

Driven by the existing `Settings.piiRetentionDays` (30–3650, or null). **Null = never anonymize; that is the
default.** The purge does nothing until an admin sets a period.

**Eligible order:** `piiRedactedAt` is null, and either `status = COMPLETED` and `completedAt` is older than
the period, or `status = CANCELLED` and `statusChangedAt` is older than the period; and it has no open
`ReturnRequest`. Orders on hold, in progress or Ready are never touched.

**What changes, per order, in one transaction** (`packages/core/src/operations/anonymize.ts`):

| Where | After |
|---|---|
| `Order.customerName` | `""` (the UI shows a translated "Customer details removed") |
| `Order.customerEmail`, `customerNote` | null |
| `Order.shippingAddress`, `billingAddress`, `shipTo`, `shipToOriginal` | reduced to `{ state, postcode, country }`; null stays null |
| `Order.shipToMessages`, `externalChangeSummary` | `[]` / null (they quote the address) |
| `Order.rawPayload` | `{ id, number, status, currency, total, date_created, date_modified, redacted: true }` |
| `OrderItem.metaData` | `[]` (custom fields can hold gift messages or names; attributes like size stay) |
| `AuditEvent.before/after` for the order, its packages and its labels | PII keys replaced with `[redacted]`, other keys kept |
| `Order.piiRedactedAt` | now |

Plus one `AuditEvent` per order (`action: "pii.anonymize"`, system actor `operations`, no before/after).

**Kept:** everything else, including label rows and **label PDFs**, note text, note photos and attachment file
names (decision 2), items, packages, rates, costs, tracking, stage events, voids and issues.

**Not tied to one order**, done in the same daily run:
- `InboundWebhook.payload` of processed deliveries older than the period → `{ redacted: true }` (only when a
  period is set).
- `IdempotentRequest` rows older than 7 days are deleted whatever the setting: they exist for replays within
  minutes and hold response DTOs with customer data.

**The job.** Queue `ops.piiPurge`, scheduled daily at 03:00 (`America/Chicago`, see *Assumptions*), anonymizes
eligible orders in batches of 200, one transaction per order, so a failure leaves the others done and the next
run picks it up. It logs counts, never names. CLI: `pnpm pii:purge [--dry-run]` (root script → worker's
`src/cli.ts purge-pii`, like `sync:pull`); `--dry-run` prints how many orders would change.

**Guards elsewhere (store-sync):** an anonymized order must not get its PII back. `applyOrder` and the webhook
processor skip an order with `piiRedactedAt` set: no update, no external-change flag; the webhook is marked
processed and its payload redacted. Manual "re-import" isn't possible for it either. Woo push still works (it
needs only `wooOrderId` and tracking).

**UI:** order detail and queue rows show "Customer details removed" when `piiRedactedAt` is set; search by
customer name naturally stops matching. The Settings field's help text says what the period does and that blank
means never.

### Backups (go-live checklist)

- `compose.prod.yml` gains a `backup` service on `postgres:17-alpine` (no new image): busybox `crond` runs
  `docker/backup/backup.sh` nightly at 02:00. It writes `pg_dump -Fc` of the `woolrus` database to the bind
  mount `./backups/woolrus-<UTC timestamp>.dump`, writes to a temp name and renames on success, then deletes dumps
  beyond the newest 14. A failed dump exits non-zero and logs to the container's stdout; the previous dumps stay.
- The GlitchTip database isn't backed up: losing error history is acceptable.
- `docs/runbook-backup-restore.md`: where dumps are, how to copy them off the host, how to restore
  (`pg_restore --clean --if-exists` into a stopped stack, then `migrate` and start), how to verify, and that the
  `storage` volume needs the host's file backup.
- **Rehearsal:** done once against the dev stack before go-live and recorded in the runbook with the date: dump,
  restore into a fresh `woolrus_restore` database, `migrate:check` clean, row counts of `orders`, `shipping_labels`
  and `audit_events` match.

### Schema changes (approved with this spec)

- `Order.piiRedactedAt DateTime? @map("pii_redacted_at") @db.Timestamptz(3)` and an index on
  `(status, completedAt)` for the eligibility query if the plan shows a sequential scan.
- `model ServiceHeartbeat { name String @id; beatAt DateTime @map("beat_at") @db.Timestamptz(3); version String?
  @@map("service_heartbeats") }`.
- No change to the hand-written constraints.

### Configuration

New env vars, added to `.env.example`, `.env.prod.example` and `turbo.json` (`env` for build, `passThroughEnv`
for dev/test): `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `WOOLRUS_VERSION` (set by CI as the image tag).
`NEXT_PUBLIC_SENTRY_DSN` is removed. `compose.prod.yml` passes `WOOLRUS_VERSION` through to web and worker.

### Files expected to change

`packages/logger/src/index.ts`, `packages/core/src/{operations/**,jobs.ts,permissions.ts,audit*.ts,actor*.ts,index.ts}`,
`packages/core/src/sync/{apply,webhooks}.ts` (guards), `packages/contracts/src/operations.ts`,
`packages/db/prisma/schema/{orders,system}.prisma` + a migration, `apps/web/src/{instrumentation.ts,instrumentation-client.ts}`,
`apps/web/src/app/{global-error.tsx,(app)/error.tsx,(app)/jobs/**,api/errors/route.ts,api/health/route.ts,layout.tsx}`,
`apps/web/src/server/{handlers,orpc,actor,router}.ts`, order detail/queue components,
`apps/worker/src/{main,cli,errors}.ts`, `docker/Dockerfile` (worker healthcheck), `docker/compose.prod.yml`,
`.env.example`, `.env.prod.example`, `turbo.json`, `biome.json`, `packages/i18n/src/messages/{en,es}.json`,
`docker/backup/backup.sh`, `docs/runbook-backup-restore.md`.

## Success criteria

1. **Errors off by default:** with `SENTRY_DSN` empty, no SDK initialises and no request goes out (unit test on
   the init helpers).
2. **Errors captured:** with a DSN pointing at a local fake ingest, an unhandled error in an oRPC procedure, in a
   route handler, in a client component and in a job's final attempt each arrives with `service`, `requestId` or
   `jobId`/`queue`, and `orderId` where there is one. An `AppError` and a non-final job attempt don't arrive.
3. **Scrubbed:** an error whose context includes an order's name, email and address arrives with those values
   `[redacted]`; no request body, cookie or authorization header is sent.
4. **Tunnel:** `/api/errors` forwards an envelope for the configured DSN, drops one for another DSN or host, and
   rejects bodies over 1 MB, answering 204 in every case.
5. **Logs:** every `/rpc` and `/api/v1` call logs one line with `procedure`, `status`, `durationMs`,
   `requestId`; the response carries `x-request-id`; an audit row written by that call has the same `requestId`.
   Every job logs its outcome with `queue`, `jobId` and `orderId` when present. A log call with a PII key prints
   `[redacted]`. Biome fails on `console.*` outside the CLI.
6. **Health:** `woocommerce` reports `ok`, `fail` (store down or 3 s timeout) and `unconfigured`; `fail` makes
   `degraded: true` with status 200; a second call within 30 s doesn't ping again. `worker` reports `ok` after a
   heartbeat and `stale` when the last one is over 3 minutes old or missing, and `stale` makes `degraded`.
7. **Containers:** with the worker stopped from consuming jobs, its container turns unhealthy within 4 minutes;
   web stays healthy.
8. **Failed jobs:** a job that exhausts its retries appears on `/jobs` with queue, error, attempts and a link to
   its order; its payload (e.g. an email address) doesn't appear in the API response. Retry re-runs it; Dismiss
   removes it; both are audited. A non-admin gets `FORBIDDEN` on all three procedures.
9. **Anonymize:** with a 30-day period, a COMPLETED order completed 31 days ago and a CANCELLED one cancelled 31
   days ago are anonymized exactly as in the table; an order completed 29 days ago, one on hold, one in QA and one
   with an open return are not. Label rows, label files, notes and photos are unchanged. Running twice changes
   nothing the second time.
10. **Never by default:** with `piiRetentionDays` null, the job changes no order and no webhook payload (it still
    deletes week-old idempotency records).
11. **No resurrection:** an `order.updated` webhook or a poll for an anonymized order leaves it anonymized and
    raises no external-change flag.
12. **Metrics survive:** after anonymization the order still has its state, ZIP, country, items, packages, label
    cost and tracking, and appears in queue counts and All Orders under its number.
13. **CLI:** `pnpm pii:purge --dry-run` prints the count and changes nothing.
14. **i18n:** every new string exists in en and es.
15. **Backups:** `backup.sh` run against the dev stack produces a dump that restores into a fresh database with
    matching row counts; with 15 dumps present it keeps the newest 14; a failing `pg_dump` leaves no partial file
    and exits non-zero. The rehearsal is recorded in the runbook.

## Assumptions

1. The warehouse's time zone for the 03:00 job is `America/Chicago`. If it isn't, it's one constant.
2. `COMPLETED` is the "shipped" state the retention clock starts from (`completedAt`), and cancellation starts it
   at `statusChangedAt`.
3. Keeping state, ZIP and country is enough for any regional metric `reporting` will want.
4. `OrderItem.metaData` isn't needed after shipping. If Woo custom fields turn out to matter for reporting, keep
   named keys instead of clearing it.
5. A 30-day pg-boss retention for failed jobs is fine for table size at this volume.

## Decisions (2026-10-28)

1. **Anonymize, don't delete.** Orders stay for metrics and history; only the customer's identity goes. State,
   ZIP and country stay.
2. **Files are kept.** Label PDFs and note photos are never deleted by the purge, so labels can be reprinted and
   claims evidenced. Accepted consequence: those files still show the full address, in storage and its backups.
3. **Retention defaults to keep forever** (`piiRetentionDays` null). Anonymization starts only when an admin sets
   a period.
4. **GlitchTip in web server, browser and worker**, browser DSN read at runtime and sent through an app tunnel.
5. **Health scope:** WooCommerce entry, worker heartbeat, container healthchecks and a failed-jobs page are all in.

6. **Backups are in this module** (open question 1): a nightly `pg_dump` service in `compose.prod.yml`, 14 kept,
   plus a restore runbook rehearsed on the dev stack.
7. **No source-map upload yet** (open question 2): minified browser traces until after go-live; adding it needs a
   GlitchTip auth token as a CI secret.

## Open questions

None.
