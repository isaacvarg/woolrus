-- CreateEnum
CREATE TYPE "scan_miss_stage" AS ENUM ('PICKING', 'PACKING', 'QA');

-- CreateEnum
CREATE TYPE "scan_miss_kind" AS ENUM ('NOT_ON_ORDER', 'UNKNOWN_CODE', 'ALREADY_DONE', 'OTHER_PACKAGE');

-- CreateTable
CREATE TABLE "scan_misses" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "stage" "scan_miss_stage" NOT NULL,
    "kind" "scan_miss_kind" NOT NULL,
    "code" TEXT NOT NULL,
    "product_name" TEXT,
    "order_item_id" UUID,
    "package_id" UUID,
    "batch_id" UUID,
    "actor_id" UUID,
    "station_id" UUID,
    "scan_id" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scan_misses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "scan_misses_scan_id_key" ON "scan_misses"("scan_id");

-- CreateIndex
CREATE INDEX "scan_misses_order_id_at_idx" ON "scan_misses"("order_id", "at");

-- CreateIndex
CREATE INDEX "scan_misses_actor_id_at_idx" ON "scan_misses"("actor_id", "at");

-- AddForeignKey
ALTER TABLE "scan_misses" ADD CONSTRAINT "scan_misses_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_misses" ADD CONSTRAINT "scan_misses_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_misses" ADD CONSTRAINT "scan_misses_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
