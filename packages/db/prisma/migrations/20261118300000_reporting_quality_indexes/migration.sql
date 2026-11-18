-- Quality (SPEC-reporting "Schema additions"): the report reads blocked scans by time across orders.

-- CreateIndex
CREATE INDEX "scan_misses_at_idx" ON "scan_misses"("at");
