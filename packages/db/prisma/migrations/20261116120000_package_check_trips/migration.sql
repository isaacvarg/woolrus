-- CreateEnum
CREATE TYPE "pack_check" AS ENUM ('OVER_MAX', 'UNDER_MIN', 'WEIGHT_OFF', 'WEIGHT_STALE', 'NO_FIT', 'BOX_NOT_SCANNED', 'CUSTOM_DIMENSIONS');

-- CreateTable
CREATE TABLE "package_check_trips" (
    "id" UUID NOT NULL,
    "package_id" UUID NOT NULL,
    "check" "pack_check" NOT NULL,
    "mode" "pack_check_mode" NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "approval_id" UUID,
    "acknowledged_at" TIMESTAMPTZ(3),
    "acknowledged_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "package_check_trips_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "package_check_trips_created_at_idx" ON "package_check_trips"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "package_check_trips_package_id_check_key" ON "package_check_trips"("package_id", "check");

-- AddForeignKey
ALTER TABLE "package_check_trips" ADD CONSTRAINT "package_check_trips_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_check_trips" ADD CONSTRAINT "package_check_trips_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "approvals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_check_trips" ADD CONSTRAINT "package_check_trips_acknowledged_by_id_fkey" FOREIGN KEY ("acknowledged_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written constraints Prisma can't express. Keep them when regenerating.
-- ---------------------------------------------------------------------------

-- A saved trip warned or blocked; an off check is never evaluated (SPEC-packing A1).
ALTER TABLE "package_check_trips" ADD CONSTRAINT "package_check_trips_mode_not_off"
  CHECK ("mode" <> 'OFF');
