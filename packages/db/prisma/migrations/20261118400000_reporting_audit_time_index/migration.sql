-- Throughput (SPEC-reporting "Throughput"): packing and QA units are credited from the audit trail,
-- read by entity type and time.

-- CreateIndex
CREATE INDEX "audit_events_entity_type_at_idx" ON "audit_events"("entity_type", "at");
