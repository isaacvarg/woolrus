-- AlterTable
ALTER TABLE "quality_issues" ADD COLUMN     "responsible_manual" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "quality_issues_order_id_status_idx" ON "quality_issues"("order_id", "status");
