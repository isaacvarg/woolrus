-- CreateEnum
CREATE TYPE "pack_check_mode" AS ENUM ('OFF', 'WARN', 'BLOCK');

-- AlterTable
ALTER TABLE "settings" ADD COLUMN     "pack_check_custom_dimensions" "pack_check_mode" NOT NULL DEFAULT 'WARN',
ADD COLUMN     "pack_check_no_fit" "pack_check_mode" NOT NULL DEFAULT 'WARN',
ADD COLUMN     "pack_check_over_max" "pack_check_mode" NOT NULL DEFAULT 'WARN',
ADD COLUMN     "pack_check_weight_off" "pack_check_mode" NOT NULL DEFAULT 'WARN',
ADD COLUMN     "pack_check_weight_off_percent" INTEGER NOT NULL DEFAULT 25,
ADD COLUMN     "pack_check_weight_stale" "pack_check_mode" NOT NULL DEFAULT 'WARN';

-- ---------------------------------------------------------------------------
-- Hand-written constraints Prisma can't express. Keep them when regenerating.
-- ---------------------------------------------------------------------------

-- Over max is a physical limit: warn or block, never off (SPEC-packing A1, decision 11).
ALTER TABLE "settings" ADD CONSTRAINT "settings_pack_check_over_max_not_off"
  CHECK ("pack_check_over_max" <> 'OFF');

-- The off-the-estimate threshold, in whole percent.
ALTER TABLE "settings" ADD CONSTRAINT "settings_pack_check_weight_off_percent_range"
  CHECK ("pack_check_weight_off_percent" BETWEEN 5 AND 100);
