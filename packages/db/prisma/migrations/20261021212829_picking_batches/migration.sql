-- AlterTable
ALTER TABLE "settings" ADD COLUMN     "pick_batch_max_orders" INTEGER NOT NULL DEFAULT 10;

-- CreateTable
CREATE TABLE "pick_batches" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "owner_id" UUID NOT NULL,
    "station_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(3),

    CONSTRAINT "pick_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pick_batch_orders" (
    "batch_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "slot" INTEGER NOT NULL,
    "removed_at" TIMESTAMPTZ(3),

    CONSTRAINT "pick_batch_orders_pkey" PRIMARY KEY ("batch_id","order_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pick_batches_number_key" ON "pick_batches"("number");

-- CreateIndex
CREATE INDEX "pick_batches_owner_id_closed_at_idx" ON "pick_batches"("owner_id", "closed_at");

-- CreateIndex
CREATE UNIQUE INDEX "pick_batch_orders_batch_id_slot_key" ON "pick_batch_orders"("batch_id", "slot");

-- AddForeignKey
ALTER TABLE "pick_batches" ADD CONSTRAINT "pick_batches_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pick_batch_orders" ADD CONSTRAINT "pick_batch_orders_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "pick_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pick_batch_orders" ADD CONSTRAINT "pick_batch_orders_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Hand-written constraints Prisma can't express (SPEC-picking "Schema additions"). Keep these when
-- regenerating.
-- ---------------------------------------------------------------------------

-- Slots run 1…50, the ceiling of Settings.pickBatchMaxOrders.
ALTER TABLE "pick_batch_orders" ADD CONSTRAINT "pick_batch_orders_slot_range"
  CHECK ("slot" BETWEEN 1 AND 50);

-- One open batch per picker.
CREATE UNIQUE INDEX "pick_batches_one_open_per_owner"
  ON "pick_batches" ("owner_id") WHERE "closed_at" IS NULL;

-- An order is in at most one open batch: membership rows of closed batches are marked removed.
CREATE UNIQUE INDEX "pick_batch_orders_one_open_per_order"
  ON "pick_batch_orders" ("order_id") WHERE "removed_at" IS NULL;
