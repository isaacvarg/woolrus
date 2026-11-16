-- AlterTable
ALTER TABLE "boxes" ADD COLUMN     "min_weight_oz" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "settings" ADD COLUMN     "pack_check_under_min" "pack_check_mode" NOT NULL DEFAULT 'WARN';

-- ---------------------------------------------------------------------------
-- Hand-written constraints Prisma can't express. Keep them when regenerating.
-- ---------------------------------------------------------------------------

-- A box's min weight is below its max when both are set (SPEC-packing A1, errors.box.minNotBelowMax).
ALTER TABLE "boxes" ADD CONSTRAINT "boxes_min_weight_below_max"
  CHECK ("min_weight_oz" IS NULL OR "max_weight_oz" IS NULL OR "min_weight_oz" < "max_weight_oz");
