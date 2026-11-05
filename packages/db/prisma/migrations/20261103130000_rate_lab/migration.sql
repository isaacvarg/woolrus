-- CreateEnum
CREATE TYPE "rate_lab_group_kind" AS ENUM ('ADDRESS', 'PARCEL');

-- CreateEnum
CREATE TYPE "rate_lab_run_kind" AS ENUM ('SUITE', 'ONE_OFF');

-- CreateEnum
CREATE TYPE "rate_lab_run_status" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "role" ADD VALUE 'RATE_LAB';

-- AlterTable
ALTER TABLE "settings" ADD COLUMN     "rate_lab_max_combinations" INTEGER NOT NULL DEFAULT 250;

-- CreateTable
CREATE TABLE "rate_lab_groups" (
    "id" UUID NOT NULL,
    "kind" "rate_lab_group_kind" NOT NULL,
    "name" TEXT NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rate_lab_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_lab_addresses" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "original" JSONB NOT NULL,
    "address" JSONB NOT NULL,
    "residential" BOOLEAN NOT NULL,
    "check_status" "ship_to_status" NOT NULL,
    "check_messages" JSONB NOT NULL DEFAULT '[]',
    "checked_at" TIMESTAMPTZ(3),
    "locked_at" TIMESTAMPTZ(3),
    "archived_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rate_lab_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_lab_address_groups" (
    "address_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,

    CONSTRAINT "rate_lab_address_groups_pkey" PRIMARY KEY ("address_id","group_id")
);

-- CreateTable
CREATE TABLE "rate_lab_parcels" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "box_id" UUID,
    "length_in" DECIMAL(8,2) NOT NULL,
    "width_in" DECIMAL(8,2) NOT NULL,
    "height_in" DECIMAL(8,2) NOT NULL,
    "weight_oz" DECIMAL(10,2) NOT NULL,
    "locked_at" TIMESTAMPTZ(3),
    "archived_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rate_lab_parcels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_lab_parcel_groups" (
    "parcel_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,

    CONSTRAINT "rate_lab_parcel_groups_pkey" PRIMARY KEY ("parcel_id","group_id")
);

-- CreateTable
CREATE TABLE "rate_lab_parcel_items" (
    "id" UUID NOT NULL,
    "parcel_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "rate_lab_parcel_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_lab_runs" (
    "id" UUID NOT NULL,
    "kind" "rate_lab_run_kind" NOT NULL,
    "status" "rate_lab_run_status" NOT NULL DEFAULT 'QUEUED',
    "started_by_id" UUID,
    "selection" JSONB NOT NULL,
    "ship_from" JSONB NOT NULL,
    "ad_hoc_address" JSONB,
    "ad_hoc_parcels" JSONB,
    "combinations" INTEGER NOT NULL,
    "completed_combinations" INTEGER NOT NULL DEFAULT 0,
    "quote_count" INTEGER NOT NULL DEFAULT 0,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "fake" BOOLEAN NOT NULL DEFAULT false,
    "cancel_requested_at" TIMESTAMPTZ(3),
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "heartbeat_at" TIMESTAMPTZ(3),

    CONSTRAINT "rate_lab_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rate_lab_address_groups_group_id_idx" ON "rate_lab_address_groups"("group_id");

-- CreateIndex
CREATE INDEX "rate_lab_parcel_groups_group_id_idx" ON "rate_lab_parcel_groups"("group_id");

-- CreateIndex
CREATE UNIQUE INDEX "rate_lab_parcel_items_parcel_id_product_id_key" ON "rate_lab_parcel_items"("parcel_id", "product_id");

-- CreateIndex
CREATE INDEX "rate_lab_runs_created_at_idx" ON "rate_lab_runs"("created_at" DESC);

-- AddForeignKey
ALTER TABLE "rate_lab_addresses" ADD CONSTRAINT "rate_lab_addresses_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_lab_address_groups" ADD CONSTRAINT "rate_lab_address_groups_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "rate_lab_addresses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_lab_address_groups" ADD CONSTRAINT "rate_lab_address_groups_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "rate_lab_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_lab_parcels" ADD CONSTRAINT "rate_lab_parcels_box_id_fkey" FOREIGN KEY ("box_id") REFERENCES "boxes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_lab_parcels" ADD CONSTRAINT "rate_lab_parcels_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_lab_parcel_groups" ADD CONSTRAINT "rate_lab_parcel_groups_parcel_id_fkey" FOREIGN KEY ("parcel_id") REFERENCES "rate_lab_parcels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_lab_parcel_groups" ADD CONSTRAINT "rate_lab_parcel_groups_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "rate_lab_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_lab_parcel_items" ADD CONSTRAINT "rate_lab_parcel_items_parcel_id_fkey" FOREIGN KEY ("parcel_id") REFERENCES "rate_lab_parcels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_lab_parcel_items" ADD CONSTRAINT "rate_lab_parcel_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_lab_runs" ADD CONSTRAINT "rate_lab_runs_started_by_id_fkey" FOREIGN KEY ("started_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_fetches" ADD CONSTRAINT "rate_fetches_lab_run_id_fkey" FOREIGN KEY ("lab_run_id") REFERENCES "rate_lab_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_fetches" ADD CONSTRAINT "rate_fetches_lab_address_id_fkey" FOREIGN KEY ("lab_address_id") REFERENCES "rate_lab_addresses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_fetches" ADD CONSTRAINT "rate_fetches_lab_parcel_id_fkey" FOREIGN KEY ("lab_parcel_id") REFERENCES "rate_lab_parcels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Hand-written constraints (SPEC-rate-lab "Data"). Keep them through any edit.

-- One suite run at a time (decision 6); one-off quotes run alongside it.
CREATE UNIQUE INDEX "rate_lab_runs_one_active_suite" ON "rate_lab_runs" ((true))
  WHERE "kind" = 'SUITE' AND "status" IN ('QUEUED', 'RUNNING');

-- Group names unique per kind, ignoring case: "West" and "west" are the same tag.
CREATE UNIQUE INDEX "rate_lab_groups_kind_name_key" ON "rate_lab_groups" ("kind", lower("name"));

-- What was typed in belongs to one-off quotes only; a suite run quotes saved addresses and parcels.
ALTER TABLE "rate_lab_runs" ADD CONSTRAINT "rate_lab_runs_ad_hoc_one_off" CHECK (
  "kind" = 'ONE_OFF' OR ("ad_hoc_address" IS NULL AND "ad_hoc_parcels" IS NULL)
);
