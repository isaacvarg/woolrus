-- CreateEnum
CREATE TYPE "approval_kind" AS ENUM ('PACKING_CHECKS');

-- CreateTable
CREATE TABLE "approvals" (
    "id" UUID NOT NULL,
    "kind" "approval_kind" NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "approved_by_id" UUID NOT NULL,
    "station_id" UUID,
    "reason" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "approvals_entity_type_entity_id_idx" ON "approvals"("entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written constraint Prisma can't express. Keep it when regenerating.
-- ---------------------------------------------------------------------------

-- Nobody approves their own request (SPEC-identity A2, decision 20); core refuses it too.
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_not_self"
  CHECK ("requested_by_id" <> "approved_by_id");
