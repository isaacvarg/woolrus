-- Provider-neutral shipping schema (SPEC-carriers "Schema changes"). Columns that held ShipStation ids are
-- renamed, not recreated, and existing rows are attributed to ShipStation, the only provider so far.
-- The init migration's hand-written constraints (one selected rate per package, one live label per package,
-- a label on exactly one of a package or a return) are untouched: no column they use changes.

-- CreateEnum
CREATE TYPE "ship_to_status" AS ENUM ('UNCHECKED', 'VERIFIED', 'CORRECTED', 'WARNING', 'ERROR', 'INCOMPLETE');

-- CreateEnum
CREATE TYPE "shipping_provider_id" AS ENUM ('SHIPSTATION', 'BRIDGE_SOURCE');

-- CreateEnum
CREATE TYPE "rates_status" AS ENUM ('NONE', 'FETCHING', 'READY', 'FAILED', 'STALE');

-- CreateTable
CREATE TABLE "shipping_provider_accounts" (
    "id" UUID NOT NULL,
    "provider" "shipping_provider_id" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "credentials_enc" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "last_checked_at" TIMESTAMPTZ(3),
    "last_error_key" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shipping_provider_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shipping_provider_accounts_provider_key" ON "shipping_provider_accounts"("provider");

-- Carriers: keyed by (provider, external id).
DROP INDEX "shipping_carriers_shipstation_carrier_id_key";
ALTER TABLE "shipping_carriers" RENAME COLUMN "shipstation_carrier_id" TO "external_id";
ALTER TABLE "shipping_carriers" DROP COLUMN "is_primary",
ADD COLUMN     "missing_since" TIMESTAMPTZ(3),
ADD COLUMN     "provider" "shipping_provider_id" NOT NULL DEFAULT 'SHIPSTATION';
ALTER TABLE "shipping_carriers" ALTER COLUMN "provider" DROP DEFAULT;
CREATE UNIQUE INDEX "shipping_carriers_provider_external_id_key" ON "shipping_carriers"("provider", "external_id");

-- Services
ALTER TABLE "carrier_services" ADD COLUMN     "missing_since" TIMESTAMPTZ(3),
ADD COLUMN     "provider_data" JSONB NOT NULL DEFAULT '{}';

-- Rates are a disposable cache (packing deletes them on every change) and the old rows carry no carrier or
-- service to point the new foreign keys at, so they are dropped and fetched again.
DELETE FROM "shipping_rates";
ALTER TABLE "shipping_rates" RENAME COLUMN "shipstation_rate_id" TO "provider_rate_id";
ALTER TABLE "shipping_rates" ALTER COLUMN "provider_rate_id" DROP NOT NULL,
ADD COLUMN     "carrier_id" UUID NOT NULL,
ADD COLUMN     "provider" "shipping_provider_id" NOT NULL,
ADD COLUMN     "provider_shipment_id" TEXT,
ADD COLUMN     "service_id" UUID NOT NULL;
CREATE INDEX "shipping_rates_carrier_id_idx" ON "shipping_rates"("carrier_id");
CREATE INDEX "shipping_rates_service_id_idx" ON "shipping_rates"("service_id");
ALTER TABLE "shipping_rates" ADD CONSTRAINT "shipping_rates_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "shipping_carriers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipping_rates" ADD CONSTRAINT "shipping_rates_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "carrier_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Labels: the provider's label id is unique per provider. Rows are never deleted.
DROP INDEX "shipping_labels_shipstation_label_id_key";
ALTER TABLE "shipping_labels" RENAME COLUMN "shipstation_label_id" TO "provider_label_id";
ALTER TABLE "shipping_labels" RENAME COLUMN "shipstation_shipment_id" TO "provider_shipment_id";
ALTER TABLE "shipping_labels" ADD COLUMN     "provider" "shipping_provider_id" NOT NULL DEFAULT 'SHIPSTATION',
ADD COLUMN     "storage_key" TEXT;
ALTER TABLE "shipping_labels" ALTER COLUMN "provider" DROP DEFAULT;
CREATE UNIQUE INDEX "shipping_labels_provider_provider_label_id_key" ON "shipping_labels"("provider", "provider_label_id");

-- Manifests: the provider's manifest id is unique per provider.
DROP INDEX "manifests_shipstation_manifest_id_key";
ALTER TABLE "manifests" RENAME COLUMN "shipstation_manifest_id" TO "provider_manifest_id";
ALTER TABLE "manifests" ADD COLUMN     "provider" "shipping_provider_id" NOT NULL DEFAULT 'SHIPSTATION';
ALTER TABLE "manifests" ALTER COLUMN "provider" DROP DEFAULT;
CREATE UNIQUE INDEX "manifests_provider_provider_manifest_id_key" ON "manifests"("provider", "provider_manifest_id");

-- Packages: a package rated by two providers has two shipments, so the shipment id lives on the rate.
ALTER TABLE "packages" DROP COLUMN "shipstation_shipment_id",
ADD COLUMN     "rate_errors" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "rates_fetched_at" TIMESTAMPTZ(3),
ADD COLUMN     "rates_status" "rates_status" NOT NULL DEFAULT 'NONE';

-- Orders: the resolved and checked ship-to, and the rate generation.
ALTER TABLE "orders" ADD COLUMN     "rate_generation" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "ship_to" JSONB,
ADD COLUMN     "ship_to_checked_at" TIMESTAMPTZ(3),
ADD COLUMN     "ship_to_messages" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "ship_to_original" JSONB,
ADD COLUMN     "ship_to_status" "ship_to_status" NOT NULL DEFAULT 'UNCHECKED';
