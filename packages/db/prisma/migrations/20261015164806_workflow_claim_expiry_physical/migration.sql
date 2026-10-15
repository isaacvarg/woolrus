-- AlterTable
ALTER TABLE "products" ADD COLUMN     "physical" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "settings" ADD COLUMN     "claim_expiry_minutes" INTEGER NOT NULL DEFAULT 30;
