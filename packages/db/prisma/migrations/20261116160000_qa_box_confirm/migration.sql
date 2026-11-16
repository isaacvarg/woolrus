-- CreateEnum
CREATE TYPE "qa_box_confirm" AS ENUM ('OFF', 'WHEN_TRIPPED', 'ALWAYS');

-- AlterTable
ALTER TABLE "packages" ADD COLUMN     "box_confirmed_at" TIMESTAMPTZ(3),
ADD COLUMN     "box_confirmed_by_id" UUID;

-- AlterTable
ALTER TABLE "settings" ADD COLUMN     "qa_box_confirm" "qa_box_confirm" NOT NULL DEFAULT 'WHEN_TRIPPED';

-- AddForeignKey
ALTER TABLE "packages" ADD CONSTRAINT "packages_box_confirmed_by_id_fkey" FOREIGN KEY ("box_confirmed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
