-- QA verification and background label purchase (SPEC-qa "Schema additions").

-- AlterTable
ALTER TABLE "package_items" ADD COLUMN     "qa_verified_quantity" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "settings" ADD COLUMN     "label_cost_confirm_free_cents" INTEGER DEFAULT 1500,
ADD COLUMN     "label_cost_confirm_ratio" DECIMAL(6,2) DEFAULT 2.0;

-- AlterTable
ALTER TABLE "shipping_labels" ADD COLUMN     "carrier_id" UUID,
ADD COLUMN     "purchase_attempted_at" TIMESTAMPTZ(3),
ADD COLUMN     "quoted_amount_cents" INTEGER,
ADD COLUMN     "service_id" UUID;

-- AddForeignKey
ALTER TABLE "shipping_labels" ADD CONSTRAINT "shipping_labels_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "shipping_carriers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_labels" ADD CONSTRAINT "shipping_labels_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "carrier_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written constraints (Prisma can't express them).

-- Rows QA had already verified count in full.
UPDATE "package_items" SET "qa_verified_quantity" = "quantity" WHERE "qa_verified_at" IS NOT NULL;

ALTER TABLE "package_items" ADD CONSTRAINT "package_items_qa_verified_quantity_range"
  CHECK ("qa_verified_quantity" BETWEEN 0 AND "quantity");

ALTER TABLE "settings" ADD CONSTRAINT "settings_label_cost_confirm_ratio_positive"
  CHECK ("label_cost_confirm_ratio" IS NULL OR "label_cost_confirm_ratio" > 0);

ALTER TABLE "settings" ADD CONSTRAINT "settings_label_cost_confirm_free_cents_positive"
  CHECK ("label_cost_confirm_free_cents" IS NULL OR "label_cost_confirm_free_cents" > 0);
