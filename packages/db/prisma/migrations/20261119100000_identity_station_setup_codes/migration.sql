-- CreateTable
CREATE TABLE "station_setup_codes" (
    "id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "station_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "station_setup_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "station_setup_codes_code_hash_key" ON "station_setup_codes"("code_hash");

-- CreateIndex
CREATE UNIQUE INDEX "station_setup_codes_station_id_key" ON "station_setup_codes"("station_id");

-- AddForeignKey
ALTER TABLE "station_setup_codes" ADD CONSTRAINT "station_setup_codes_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "station_setup_codes" ADD CONSTRAINT "station_setup_codes_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

