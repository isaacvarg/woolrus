-- CreateIndex
CREATE UNIQUE INDEX "package_items_package_id_order_item_id_key" ON "package_items"("package_id", "order_item_id");
