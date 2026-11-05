-- DropIndex
DROP INDEX "shipping_labels_status_idx";

-- CreateIndex
CREATE INDEX "shipping_labels_status_purchased_at_idx" ON "shipping_labels"("status", "purchased_at");
