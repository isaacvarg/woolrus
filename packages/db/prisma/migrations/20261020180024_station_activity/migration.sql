-- AlterTable
ALTER TABLE "station_activations" ADD COLUMN     "last_activity_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
