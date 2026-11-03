-- CreateEnum
CREATE TYPE "rate_fetch_source" AS ENUM ('ORDER', 'LAB');

-- CreateEnum
CREATE TYPE "rate_fetch_trigger" AS ENUM ('PACKING_COMPLETE', 'REFRESH', 'ADDRESS_CHANGE', 'LAB_RUN');

-- CreateEnum
CREATE TYPE "rate_selection_reason" AS ENUM ('FASTER_DELIVERY', 'CUSTOMER_REQUESTED', 'CARRIER_RELIABILITY', 'CHEAPEST_UNAVAILABLE', 'OTHER');

-- AlterTable
ALTER TABLE "shipping_labels" ADD COLUMN     "rate_quote_id" UUID,
ADD COLUMN     "selection_note" TEXT,
ADD COLUMN     "selection_reason" "rate_selection_reason";

-- AlterTable
ALTER TABLE "shipping_rates" ADD COLUMN     "quote_id" UUID,
ADD COLUMN     "selection_note" TEXT,
ADD COLUMN     "selection_reason" "rate_selection_reason";

-- CreateTable
CREATE TABLE "rate_fetches" (
    "id" UUID NOT NULL,
    "source" "rate_fetch_source" NOT NULL,
    "trigger" "rate_fetch_trigger" NOT NULL,
    "order_id" UUID,
    "package_id" UUID,
    "lab_run_id" UUID,
    "lab_address_id" UUID,
    "lab_parcel_id" UUID,
    "dest_country" CHAR(2) NOT NULL,
    "dest_state" TEXT,
    "dest_zip3" TEXT,
    "residential" BOOLEAN NOT NULL,
    "international" BOOLEAN NOT NULL,
    "box_id" UUID,
    "length_in" DECIMAL(8,2) NOT NULL,
    "width_in" DECIMAL(8,2) NOT NULL,
    "height_in" DECIMAL(8,2) NOT NULL,
    "weight_oz" DECIMAL(10,2) NOT NULL,
    "provider_errors" JSONB NOT NULL DEFAULT '[]',
    "fake" BOOLEAN NOT NULL,
    "fetched_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_fetches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_quotes" (
    "id" UUID NOT NULL,
    "fetch_id" UUID NOT NULL,
    "provider" "shipping_provider_id" NOT NULL,
    "carrier_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "carrier_code" TEXT NOT NULL,
    "service_code" TEXT NOT NULL,
    "service_name" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "delivery_days" INTEGER,
    "estimated_delivery_at" TIMESTAMPTZ(3),
    "guaranteed" BOOLEAN NOT NULL,
    "quote_only" BOOLEAN NOT NULL,
    "cheapest" BOOLEAN NOT NULL,
    "fake" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rate_fetches_source_fetched_at_idx" ON "rate_fetches"("source", "fetched_at" DESC);

-- CreateIndex
CREATE INDEX "rate_fetches_order_id_idx" ON "rate_fetches"("order_id");

-- CreateIndex
CREATE INDEX "rate_fetches_package_id_idx" ON "rate_fetches"("package_id");

-- CreateIndex
CREATE INDEX "rate_fetches_lab_run_id_idx" ON "rate_fetches"("lab_run_id");

-- CreateIndex
CREATE INDEX "rate_fetches_lab_address_id_lab_parcel_id_fetched_at_idx" ON "rate_fetches"("lab_address_id", "lab_parcel_id", "fetched_at");

-- CreateIndex
CREATE INDEX "rate_quotes_fetch_id_idx" ON "rate_quotes"("fetch_id");

-- CreateIndex
CREATE INDEX "rate_quotes_carrier_id_service_id_created_at_idx" ON "rate_quotes"("carrier_id", "service_id", "created_at");

-- CreateIndex
CREATE INDEX "shipping_labels_rate_quote_id_idx" ON "shipping_labels"("rate_quote_id");

-- CreateIndex
CREATE INDEX "shipping_rates_quote_id_idx" ON "shipping_rates"("quote_id");

-- AddForeignKey
ALTER TABLE "shipping_rates" ADD CONSTRAINT "shipping_rates_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "rate_quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_labels" ADD CONSTRAINT "shipping_labels_rate_quote_id_fkey" FOREIGN KEY ("rate_quote_id") REFERENCES "rate_quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_fetches" ADD CONSTRAINT "rate_fetches_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_fetches" ADD CONSTRAINT "rate_fetches_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "packages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_fetches" ADD CONSTRAINT "rate_fetches_box_id_fkey" FOREIGN KEY ("box_id") REFERENCES "boxes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_quotes" ADD CONSTRAINT "rate_quotes_fetch_id_fkey" FOREIGN KEY ("fetch_id") REFERENCES "rate_fetches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_quotes" ADD CONSTRAINT "rate_quotes_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "shipping_carriers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_quotes" ADD CONSTRAINT "rate_quotes_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "carrier_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written constraints (SPEC-rate-history "Schema changes"). Keep them through any edit.

-- An order's fetch has no lab ids; a Rate Lab fetch belongs to a run and to no order or package.
ALTER TABLE "rate_fetches" ADD CONSTRAINT "rate_fetches_source_ids" CHECK (
  ("source" = 'ORDER' AND num_nonnulls("lab_run_id", "lab_address_id", "lab_parcel_id") = 0)
  OR ("source" = 'LAB' AND "order_id" IS NULL AND "package_id" IS NULL AND "lab_run_id" IS NOT NULL)
);

-- A note explains only "Other" (a bare `= 'OTHER'` would let a NULL reason through).
ALTER TABLE "shipping_rates" ADD CONSTRAINT "shipping_rates_selection_note_other"
  CHECK ("selection_note" IS NULL OR ("selection_reason" IS NOT NULL AND "selection_reason" = 'OTHER'));
ALTER TABLE "shipping_labels" ADD CONSTRAINT "shipping_labels_selection_note_other"
  CHECK ("selection_note" IS NULL OR ("selection_reason" IS NOT NULL AND "selection_reason" = 'OTHER'));
