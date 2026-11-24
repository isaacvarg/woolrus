-- AlterTable
ALTER TABLE "boxes" ADD COLUMN     "group_id" UUID;

-- CreateTable
CREATE TABLE "box_groups" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "box_groups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "boxes_group_id_idx" ON "boxes"("group_id");

-- AddForeignKey
ALTER TABLE "boxes" ADD CONSTRAINT "boxes_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "box_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written (SPEC-packing A2): group names are unique ignoring case. Prisma can't express an
-- expression index, so keep this when editing the migration.
CREATE UNIQUE INDEX "box_groups_name_lower" ON "box_groups" (lower("name"));
