-- The address check's residential answer, kept so a later fetch of the stored ship-to prices it the same
-- (SPEC-carriers "Rate fetch"). Null when the check gave none, or the address was never checked.
ALTER TABLE "orders" ADD COLUMN "ship_to_residential" BOOLEAN;
