-- CreateTable
CREATE TABLE "service_heartbeats" (
    "name" TEXT NOT NULL,
    "beat_at" TIMESTAMPTZ(3) NOT NULL,
    "version" TEXT,

    CONSTRAINT "service_heartbeats_pkey" PRIMARY KEY ("name")
);
