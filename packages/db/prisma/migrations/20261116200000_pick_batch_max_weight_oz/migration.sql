-- AlterTable
ALTER TABLE "settings" ADD COLUMN     "pick_batch_max_weight_oz" INTEGER DEFAULT 3200;

-- Hand-written (SPEC-picking A1): the cart weight limit for suggested batches, 1–500 lb. Null is off.
ALTER TABLE "settings" ADD CONSTRAINT "settings_pick_batch_max_weight_oz_range"
  CHECK ("pick_batch_max_weight_oz" BETWEEN 16 AND 8000);
