-- Throughput (SPEC-reporting "Schema additions"): the report reads picks, packs, QA checks and
-- stage events by time.

-- CreateIndex
CREATE INDEX "order_items_picked_at_idx" ON "order_items"("picked_at");

-- CreateIndex
CREATE INDEX "order_stage_events_at_idx" ON "order_stage_events"("at");

-- CreateIndex
CREATE INDEX "package_items_packed_at_idx" ON "package_items"("packed_at");

-- CreateIndex
CREATE INDEX "package_items_qa_verified_at_idx" ON "package_items"("qa_verified_at");
