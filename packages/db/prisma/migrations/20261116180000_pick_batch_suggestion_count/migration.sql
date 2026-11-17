-- AlterTable
ALTER TABLE "settings" ADD COLUMN     "pick_batch_suggestion_count" INTEGER NOT NULL DEFAULT 3;

-- Hand-written (SPEC-picking A1): how many suggested batches the Pending queue shows.
ALTER TABLE "settings" ADD CONSTRAINT "settings_pick_batch_suggestion_count_range"
  CHECK ("pick_batch_suggestion_count" BETWEEN 1 AND 10);
