-- AlterTable
ALTER TABLE "audit_events" ADD COLUMN     "order_id" UUID;

-- CreateIndex
CREATE INDEX "audit_events_order_id_at_idx" ON "audit_events"("order_id", "at");

-- Hand-written (SPEC-order-activity "Order on audit rows"). Everything between the backfill markers
-- only touches rows whose order_id is null, so it can run again; the migration test replays it.
-- backfill:begin

-- Entity types are model names; two writers used lowercase names.
UPDATE "audit_events" SET "entity_type" = 'Order' WHERE "entity_type" = 'order';
UPDATE "audit_events" SET "entity_type" = 'Manifest' WHERE "entity_type" = 'manifest';

-- First match wins: the entity itself (or, for an approval, the entity it guarded), then an
-- orderId recorded in before/after for entities that have since been deleted.
WITH "target" AS (
  SELECT
    "id",
    CASE WHEN "entity_type" = 'Approval' THEN "after"->>'entityType' ELSE "entity_type" END AS "type",
    CASE WHEN "entity_type" = 'Approval' THEN "after"->>'entityId' ELSE "entity_id" END AS "tid",
    "before"->>'orderId' AS "before_order",
    "after"->>'orderId' AS "after_order"
  FROM "audit_events"
  WHERE "order_id" IS NULL
), "typed" AS (
  SELECT
    "id",
    "type",
    CASE WHEN "tid" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN "tid"::uuid END AS "uid",
    CASE WHEN "before_order" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN "before_order"::uuid END AS "before_order",
    CASE WHEN "after_order" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN "after_order"::uuid END AS "after_order"
  FROM "target"
), "resolved" AS (
  SELECT
    t."id",
    COALESCE(
      CASE WHEN t."type" = 'Order' THEN t."uid" END,
      (SELECT x."order_id" FROM "order_items" x WHERE t."type" = 'OrderItem' AND x."id" = t."uid"),
      (SELECT x."order_id" FROM "item_voids" x WHERE t."type" = 'ItemVoid' AND x."id" = t."uid"),
      (SELECT x."order_id" FROM "quality_issues" x WHERE t."type" = 'QualityIssue' AND x."id" = t."uid"),
      (SELECT x."order_id" FROM "notes" x WHERE t."type" = 'Note' AND x."id" = t."uid"),
      (SELECT x."order_id" FROM "packages" x WHERE t."type" = 'Package' AND x."id" = t."uid"),
      (SELECT p."order_id" FROM "package_check_trips" x JOIN "packages" p ON p."id" = x."package_id"
        WHERE t."type" = 'PackageCheckTrip' AND x."id" = t."uid"),
      (SELECT p."order_id" FROM "package_items" x JOIN "packages" p ON p."id" = x."package_id"
        WHERE t."type" = 'PackageItem' AND x."id" = t."uid"),
      (SELECT p."order_id" FROM "shipping_labels" x JOIN "packages" p ON p."id" = x."package_id"
        WHERE t."type" = 'ShippingLabel' AND x."id" = t."uid"),
      t."before_order",
      t."after_order"
    ) AS "order_id"
  FROM "typed" t
)
UPDATE "audit_events" a
SET "order_id" = r."order_id"
FROM "resolved" r
WHERE a."id" = r."id" AND r."order_id" IS NOT NULL;

-- backfill:end
