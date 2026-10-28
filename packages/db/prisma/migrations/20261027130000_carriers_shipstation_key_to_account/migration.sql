-- The ShipStation API key moves from Settings to its provider account (SPEC-carriers "Provider accounts and
-- settings"). The ciphertext is copied as it is (same key, same v1: format); it holds the bare key rather than
-- the account's JSON blob, which core reads as `{ apiKey }` (adapters/shipping/credentials.ts).
-- An account that already has credentials keeps them.

INSERT INTO "shipping_provider_accounts" ("id", "provider", "credentials_enc", "updated_at")
SELECT gen_random_uuid(), 'SHIPSTATION', "shipstation_api_key_enc", CURRENT_TIMESTAMP
FROM "settings"
WHERE "id" = 1 AND "shipstation_api_key_enc" IS NOT NULL
ON CONFLICT ("provider") DO UPDATE
SET "credentials_enc" = EXCLUDED."credentials_enc", "updated_at" = CURRENT_TIMESTAMP
WHERE "shipping_provider_accounts"."credentials_enc" IS NULL;

-- AlterTable
ALTER TABLE "settings" DROP COLUMN "shipstation_api_key_enc";
