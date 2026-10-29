-- Orders whose customer identity was removed by the PII purge (NFR-SEC-06).

-- AlterTable
ALTER TABLE "orders" ADD COLUMN "pii_redacted_at" TIMESTAMPTZ(3);
