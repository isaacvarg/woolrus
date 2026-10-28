-- Carrier accounts get a label set in Settings → Shipping, plus what the provider says about each
-- account, so several accounts of one carrier (three UPS accounts in one ShipStation) can be told
-- apart. `nickname` was never written, so it becomes the label.

-- AlterTable
ALTER TABLE "shipping_carriers" RENAME COLUMN "nickname" TO "label";
ALTER TABLE "shipping_carriers" ADD COLUMN "provider_nickname" TEXT,
ADD COLUMN "account_suffix" TEXT,
ADD COLUMN "billed_by_provider" BOOLEAN NOT NULL DEFAULT false;
