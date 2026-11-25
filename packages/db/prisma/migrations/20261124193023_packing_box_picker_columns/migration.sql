-- AlterTable
ALTER TABLE "users" ADD COLUMN     "box_picker_columns" INTEGER NOT NULL DEFAULT 1;

-- Hand-written (SPEC-packing A2): the picker has one or two columns, nothing else.
ALTER TABLE "users" ADD CONSTRAINT "users_box_picker_columns_check" CHECK ("box_picker_columns" IN (1, 2));
