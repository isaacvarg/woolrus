-- Hand-written constraint (SPEC-rate-lab "One-off quotes"). Prisma can't express a partial unique
-- index, so `migrate diff` doesn't see it; keep it through any edit.

-- A database that already has two running one-offs for one person keeps the newest; the others
-- were left by requests that died, and would fail as stalled anyway.
UPDATE "rate_lab_runs" r
SET "status" = 'FAILED', "error" = 'errors.rateLab.stalled', "finished_at" = now()
WHERE r."kind" = 'ONE_OFF' AND r."status" = 'RUNNING' AND EXISTS (
  SELECT 1 FROM "rate_lab_runs" newer
  WHERE newer."kind" = 'ONE_OFF' AND newer."status" = 'RUNNING'
    AND newer."started_by_id" = r."started_by_id" AND newer."id" > r."id"
);

-- One running one-off per person: each quotes inline through every enabled provider with the
-- credentials everyone shares, so a loop of them could exhaust a carrier's API quota.
CREATE UNIQUE INDEX "rate_lab_runs_one_running_one_off_per_user" ON "rate_lab_runs" ("started_by_id")
  WHERE "kind" = 'ONE_OFF' AND "status" = 'RUNNING';
