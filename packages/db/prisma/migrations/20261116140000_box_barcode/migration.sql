-- AlterTable
ALTER TABLE "boxes" ADD COLUMN     "barcode" TEXT;

-- AlterTable
ALTER TABLE "packages" ADD COLUMN     "box_scanned" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "settings" ADD COLUMN     "pack_check_box_not_scanned" "pack_check_mode" NOT NULL DEFAULT 'OFF';

-- CreateIndex
CREATE UNIQUE INDEX "boxes_barcode_key" ON "boxes"("barcode");

-- ---------------------------------------------------------------------------
-- Hand-written constraints Prisma can't express. Keep them when regenerating.
-- ---------------------------------------------------------------------------

-- A box barcode is stored normalized (as `normalizeCode` does), so the unique index compares scans
-- the way the pack screen does; an empty one is stored as NULL (SPEC-packing A1).
ALTER TABLE "boxes" ADD CONSTRAINT "boxes_barcode_normalized"
  CHECK ("barcode" IS NULL OR ("barcode" <> '' AND "barcode" = upper("barcode")));
