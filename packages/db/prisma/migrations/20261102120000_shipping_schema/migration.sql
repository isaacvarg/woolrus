-- Shipping schema additions (SPEC-shipping "Schema, permission and dependency additions").

-- AlterEnum
ALTER TYPE "label_status" ADD VALUE 'WRITTEN_OFF';

-- AlterTable
ALTER TABLE "manifests" ADD COLUMN     "storage_key" TEXT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "woo_tracking_note_id" INTEGER;

-- AlterTable
ALTER TABLE "packages" ADD COLUMN     "discarded_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "settings" ADD COLUMN     "woo_tracking_enabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "shipping_labels" ADD COLUMN     "woo_tracking_id" TEXT;

-- CreateTable
CREATE TABLE "label_prints" (
    "id" UUID NOT NULL,
    "created_by_id" UUID,
    "label_ids" UUID[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "label_prints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "label_prints_created_at_idx" ON "label_prints"("created_at");

-- AddForeignKey
ALTER TABLE "label_prints" ADD CONSTRAINT "label_prints_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
