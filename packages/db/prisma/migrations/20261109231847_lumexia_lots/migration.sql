/*
  Warnings:

  - You are about to drop the column `lot_code` on the `package_items` table. All the data in the column will be lost.
  - You are about to drop the column `lumexia_lot_id` on the `package_items` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "lot_status" AS ENUM ('UNVERIFIED', 'VALID', 'NOT_FOUND', 'WRONG_ITEM');

-- DropIndex
DROP INDEX "package_items_lot_code_idx";

-- AlterTable
ALTER TABLE "package_items" DROP COLUMN "lot_code",
DROP COLUMN "lumexia_lot_id";

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "lot_override" BOOLEAN,
ADD COLUMN     "lumexia_inventory_type_id" UUID,
ADD COLUMN     "lumexia_item_ref" TEXT,
ADD COLUMN     "lumexia_item_type_id" UUID,
ADD COLUMN     "lumexia_procurement_type_id" UUID,
ADD COLUMN     "lumexia_synced_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "settings" ADD COLUMN     "lumexia_lot_inventory_type_ids" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "lumexia_lot_item_type_ids" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "lumexia_lot_procurement_type_ids" UUID[] DEFAULT ARRAY[]::UUID[];

-- CreateTable
CREATE TABLE "package_item_lots" (
    "id" UUID NOT NULL,
    "package_item_id" UUID NOT NULL,
    "lot_number" TEXT,
    "lumexia_lot_id" TEXT,
    "quantity" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "status" "lot_status" NOT NULL DEFAULT 'UNVERIFIED',
    "scanned_by_id" UUID,
    "scanned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checked_at" TIMESTAMPTZ(3),

    CONSTRAINT "package_item_lots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "package_item_lots_lot_number_idx" ON "package_item_lots"("lot_number");

-- CreateIndex
CREATE INDEX "package_item_lots_status_idx" ON "package_item_lots"("status");

-- CreateIndex
CREATE UNIQUE INDEX "package_item_lots_package_item_id_lot_number_key" ON "package_item_lots"("package_item_id", "lot_number");

-- CreateIndex
CREATE UNIQUE INDEX "package_item_lots_package_item_id_lumexia_lot_id_key" ON "package_item_lots"("package_item_id", "lumexia_lot_id");

-- AddForeignKey
ALTER TABLE "package_item_lots" ADD CONSTRAINT "package_item_lots_package_item_id_fkey" FOREIGN KEY ("package_item_id") REFERENCES "package_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_item_lots" ADD CONSTRAINT "package_item_lots_scanned_by_id_fkey" FOREIGN KEY ("scanned_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written (keep when editing this migration): a lot row always holds at least one unit; a lot
-- whose units are all taken is deleted instead (SPEC-lumexia "The split rule").
ALTER TABLE "package_item_lots" ADD CONSTRAINT "package_item_lots_quantity_positive" CHECK ("quantity" > 0);
