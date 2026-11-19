# Runbook: backup and restore

## What is backed up

- **Postgres `woolrus` database:** the `backup` service in `docker/compose.prod.yml` (the `woolrus-backup` image,
  which bakes in `docker/backup/backup.sh`) runs at 02:00 UTC, or on `BACKUP_SCHEDULE`. It writes `pg_dump -Fc`
  output to `/backups/woolrus-<UTC timestamp>.dump`, under a temp name that is renamed on success, and keeps the
  newest 14. `/backups` is the named volume `backups`, or the host folder in `BACKUP_PATH` if that is an absolute
  path. The service runs as root and dumps are mode `0600`, so reading them on the host needs `sudo`.
  Dumps hold customer data, so treat them like the database: a dump keeps personal data for up to 14 days after
  the PII purge removed it from the live database. A failed dump
  exits non-zero, logs to the container's stdout (`docker compose -f compose.prod.yml logs backup`) and leaves
  earlier dumps alone.
- **Not backed up here:** the `glitchtip` database (losing error history is acceptable) and the **`storage` volume**
  (label PDFs, note photos). The `storage` volume needs the host's own file backup. Without it, labels can't be
  reprinted after a disk loss.

## Copy dumps off the host

Dumps on the same disk don't survive a disk failure. Copy them off nightly (after 02:00), for example:

```bash
sudo rsync -a --include='woolrus-*.dump' --exclude='*' "$BACKUP_PATH/" /offsite/woolrus/
```

With the default named volume, the folder is `docker volume inspect -f '{{ .Mountpoint }}' woolrus_backups`
(prefix is the compose project name). An absolute `BACKUP_PATH` is easier to point a backup job at.

Run it as root on the host (the dumps are root-only), and send them over an encrypted channel (SSH) to an
encrypted or access-restricted destination: they are not encrypted themselves.

## Restore

Run from the folder holding `compose.prod.yml` on the host (Arcane's project folder, or use its container
shell for step 2). This replaces the current database contents.

1. Stop the apps, keep Postgres and the backup container (it can see the dumps and has `pg_restore`):
   `docker compose -f compose.prod.yml stop web worker glitchtip`
2. Pick a dump (newest is last), then restore it:
   ```bash
   docker compose -f compose.prod.yml exec backup ls /backups
   docker compose -f compose.prod.yml exec backup \
     pg_restore -d woolrus --clean --if-exists --no-owner /backups/woolrus-<timestamp>.dump
   ```
3. Run migrations (a no-op if the dump is current, applies pending ones if the dump is older than the running
   release): `docker compose -f compose.prod.yml up migrate`
4. Start everything: `docker compose -f compose.prod.yml up -d`

If the Postgres volume is lost, start `postgres` first (the init script recreates the empty databases), then
follow the same steps.

## Verify

- `docker compose -f compose.prod.yml exec postgres psql -U woolrus -d woolrus -c "select count(*) from orders"`
  (and `shipping_labels`, `audit_events`) against figures you noted before, or the source database in a rehearsal.
- `pnpm --filter @woolrus/db migrate:check` with `DATABASE_URL` pointing at the restored database reports no drift
  beyond what the source database had.
- Sign in, open an order, reprint a label (this also confirms the `storage` volume).

## Rehearsal log

### 2026-10-28, dev stack

Ran `backup.sh` (in a `postgres:17-alpine` container, against the dev stack's `woolrus` database), restored the
dump with `pg_restore --no-owner` into a fresh `woolrus_restore` database, then dropped it.

- Dump: 3.9 MB, written and renamed without a partial file.
- Row counts, source vs restored: `orders` 50 / 50, `shipping_labels` 8 / 8, `audit_events` 21794 / 21794.
- `_prisma_migrations`: 14 / 14 rows.
- `migrate:check`: output identical for the source and the restored database. Both report schema drift unrelated to
  the restore (the dev database still has the carrier columns `shipping_labels.carrier_id`, `service_id`,
  `quoted_amount_cents`, `purchase_attempted_at` that the current schema removes), so the restore reproduces the
  source exactly but the check isn't clean on this dev database until that drift is resolved. Re-run on a fresh
  database before go-live.

### 2026-10-29, fresh database

Dumped a database built from the migrations alone (the e2e database, so no dev-stack drift) with `pg_dump -Fc`,
restored it with `pg_restore --no-owner` into a new database, then dropped that.

- Row counts, source vs restored: `audit_events` 2094 / 2094, `_prisma_migrations` 15 / 15 (`orders` and
  `shipping_labels` were empty in this database, so the 2026-10-28 rehearsal above remains the evidence for them).
- `migrate:check` on the restored database: no difference detected. The earlier drift came from the dev database,
  not from the restore.
