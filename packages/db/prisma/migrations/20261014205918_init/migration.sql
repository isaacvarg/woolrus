-- CreateEnum
CREATE TYPE "role" AS ENUM ('ADMIN', 'PICKER', 'PACKER', 'QA', 'SHIPPER');

-- CreateEnum
CREATE TYPE "theme" AS ENUM ('SYSTEM', 'LIGHT', 'DARK', 'HIGH_CONTRAST');

-- CreateEnum
CREATE TYPE "locale" AS ENUM ('en', 'es');

-- CreateEnum
CREATE TYPE "station_unlock_method" AS ENUM ('PIN', 'BADGE');

-- CreateEnum
CREATE TYPE "station_lock_reason" AS ENUM ('SWITCHED_USER', 'IDLE', 'MANUAL', 'STATION_REVOKED');

-- CreateEnum
CREATE TYPE "workflow_status" AS ENUM ('PENDING', 'PICKING', 'PACKING', 'QA', 'READY', 'COMPLETED', 'ON_HOLD', 'CANCELLED');

-- CreateEnum
CREATE TYPE "fulfillment_stage" AS ENUM ('INTAKE', 'PICKING', 'PACKING', 'QA', 'SHIPPING', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "pick_status" AS ENUM ('PENDING', 'PICKED', 'OUT_OF_STOCK', 'SUBSTITUTED');

-- CreateEnum
CREATE TYPE "woo_push_status" AS ENUM ('NOT_NEEDED', 'PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "void_resolution" AS ENUM ('HANDLED_MANUALLY', 'REFUNDED', 'LINE_EDITED');

-- CreateEnum
CREATE TYPE "note_visibility" AS ENUM ('INTERNAL', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "attachment_kind" AS ENUM ('IMAGE', 'VOICE');

-- CreateEnum
CREATE TYPE "quality_issue_type" AS ENUM ('WRONG_ITEM', 'DAMAGED_ITEM', 'MISSING_ITEM', 'WRONG_QUANTITY', 'PACKAGING_DAMAGE', 'LABELING_ERROR', 'WRONG_BOX_SIZE', 'OTHER');

-- CreateEnum
CREATE TYPE "quality_issue_severity" AS ENUM ('MINOR', 'MAJOR', 'CRITICAL');

-- CreateEnum
CREATE TYPE "quality_issue_status" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "return_status" AS ENUM ('REQUESTED', 'APPROVED', 'LABEL_SENT', 'RECEIVED', 'INSPECTED', 'CLOSED', 'REJECTED');

-- CreateEnum
CREATE TYPE "return_item_condition" AS ENUM ('UNOPENED', 'OPENED', 'DAMAGED', 'NOT_RECEIVED');

-- CreateEnum
CREATE TYPE "label_status" AS ENUM ('PURCHASING', 'ACTIVE', 'PURCHASE_FAILED', 'VOID_REQUESTED', 'VOIDED', 'VOID_REJECTED');

-- CreateEnum
CREATE TYPE "weight_display" AS ENUM ('LB_DECIMAL', 'LB_OZ');

-- CreateEnum
CREATE TYPE "sync_type" AS ENUM ('ORDERS_POLL', 'ORDERS_WEBHOOK', 'PRODUCTS', 'CARRIERS');

-- CreateEnum
CREATE TYPE "sync_status" AS ENUM ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "roles" "role"[] DEFAULT ARRAY[]::"role"[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "locale" "locale" NOT NULL DEFAULT 'en',
    "theme" "theme" NOT NULL DEFAULT 'SYSTEM',
    "sidebar_collapsed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "pin_hash" TEXT,
    "pin_failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "pin_locked_until" TIMESTAMPTZ(3),
    "badge_code" TEXT,
    "badge_issued_at" TIMESTAMPTZ(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "account_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "id_token" TEXT,
    "access_token_expires_at" TIMESTAMPTZ(3),
    "refresh_token_expires_at" TIMESTAMPTZ(3),
    "scope" TEXT,
    "password" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifications" (
    "id" UUID NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "roles" "role"[],
    "invited_by_id" UUID,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "registered_by_id" UUID,
    "last_seen_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "station_activations" (
    "id" UUID NOT NULL,
    "station_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "method" "station_unlock_method" NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(3),
    "end_reason" "station_lock_reason",

    CONSTRAINT "station_activations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "woo_product_id" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "image_url" TEXT,
    "price_cents" INTEGER,
    "weight_oz" DECIMAL(10,2),
    "length_in" DECIMAL(8,2),
    "width_in" DECIMAL(8,2),
    "height_in" DECIMAL(8,2),
    "stock_quantity" INTEGER,
    "bin_location" TEXT,
    "barcode" TEXT,
    "hs_code" TEXT,
    "country_of_origin" CHAR(2),
    "customs_description" TEXT,
    "lumexia_item_id" TEXT,
    "raw_payload" JSONB NOT NULL,
    "synced_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variations" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "woo_variation_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "attributes" JSONB NOT NULL,
    "image_url" TEXT,
    "price_cents" INTEGER,
    "weight_oz" DECIMAL(10,2),
    "length_in" DECIMAL(8,2),
    "width_in" DECIMAL(8,2),
    "height_in" DECIMAL(8,2),
    "stock_quantity" INTEGER,
    "bin_location" TEXT,
    "barcode" TEXT,
    "lumexia_item_id" TEXT,
    "raw_payload" JSONB NOT NULL,
    "synced_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_variations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "woo_order_id" INTEGER NOT NULL,
    "number" TEXT NOT NULL,
    "woo_status" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "customer_name" TEXT NOT NULL,
    "customer_email" TEXT,
    "shipping_address" JSONB NOT NULL,
    "billing_address" JSONB NOT NULL,
    "customer_note" TEXT,
    "payment_method" TEXT,
    "total_cents" INTEGER NOT NULL,
    "shipping_method" TEXT,
    "shipping_charged_cents" INTEGER NOT NULL DEFAULT 0,
    "ordered_at" TIMESTAMPTZ(3) NOT NULL,
    "woo_modified_at" TIMESTAMPTZ(3) NOT NULL,
    "synced_at" TIMESTAMPTZ(3) NOT NULL,
    "raw_payload" JSONB NOT NULL,
    "status" "workflow_status" NOT NULL DEFAULT 'PENDING',
    "status_changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "hold_reason" TEXT,
    "held_from_status" "workflow_status",
    "claimed_by_id" UUID,
    "claimed_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "external_change_detected_at" TIMESTAMPTZ(3),
    "external_change_summary" JSONB,
    "woo_push_status" "woo_push_status" NOT NULL DEFAULT 'NOT_NEEDED',
    "woo_push_attempts" INTEGER NOT NULL DEFAULT 0,
    "woo_pushed_at" TIMESTAMPTZ(3),
    "woo_push_error" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "woo_line_item_id" INTEGER NOT NULL,
    "product_id" UUID,
    "variation_id" UUID,
    "bundle_parent_id" UUID,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "quantity" INTEGER NOT NULL,
    "unit_price_cents" INTEGER NOT NULL,
    "image_url" TEXT,
    "attributes" JSONB NOT NULL DEFAULT '[]',
    "meta_data" JSONB NOT NULL DEFAULT '[]',
    "pick_status" "pick_status" NOT NULL DEFAULT 'PENDING',
    "picked_quantity" INTEGER NOT NULL DEFAULT 0,
    "picked_by_id" UUID,
    "picked_at" TIMESTAMPTZ(3),
    "substitution_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_stage_events" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "from_status" "workflow_status",
    "to_status" "workflow_status" NOT NULL,
    "actor_id" UUID,
    "station_id" UUID,
    "reason" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_stage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_voids" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "stage" "fulfillment_stage" NOT NULL,
    "voided_by_id" UUID,
    "voided_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undone_by_id" UUID,
    "undone_at" TIMESTAMPTZ(3),
    "resolution" "void_resolution",
    "resolution_notes" TEXT,
    "woo_refund_id" INTEGER,
    "resolved_by_id" UUID,
    "resolved_at" TIMESTAMPTZ(3),

    CONSTRAINT "item_voids_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "priority_rules" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL,
    "condition" JSONB NOT NULL,
    "priority" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "priority_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notes" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_item_id" UUID,
    "package_id" UUID,
    "quality_issue_id" UUID,
    "return_id" UUID,
    "author_id" UUID,
    "content" TEXT NOT NULL,
    "visibility" "note_visibility" NOT NULL DEFAULT 'INTERNAL',
    "woo_note_id" INTEGER,
    "pushed_to_woo_at" TIMESTAMPTZ(3),
    "edited_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "note_attachments" (
    "id" UUID NOT NULL,
    "note_id" UUID NOT NULL,
    "kind" "attachment_kind" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "thumbnail_key" TEXT,
    "content_type" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "note_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_issues" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_item_id" UUID,
    "package_id" UUID,
    "label_id" UUID,
    "type" "quality_issue_type" NOT NULL,
    "severity" "quality_issue_severity" NOT NULL,
    "status" "quality_issue_status" NOT NULL DEFAULT 'OPEN',
    "description" TEXT NOT NULL,
    "discovered_stage" "fulfillment_stage" NOT NULL,
    "origin_stage" "fulfillment_stage",
    "customer_reported" BOOLEAN NOT NULL DEFAULT false,
    "reporter_id" UUID,
    "responsible_user_id" UUID,
    "triggered_repack" BOOLEAN NOT NULL DEFAULT false,
    "resolution_notes" TEXT,
    "resolved_by_id" UUID,
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quality_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_requests" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "rma_number" TEXT NOT NULL,
    "status" "return_status" NOT NULL DEFAULT 'REQUESTED',
    "reason" TEXT NOT NULL,
    "quality_issue_id" UUID,
    "created_by_id" UUID,
    "received_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "return_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_items" (
    "id" UUID NOT NULL,
    "return_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "condition" "return_item_condition",
    "restock" BOOLEAN NOT NULL DEFAULT false,
    "lot_code" TEXT,

    CONSTRAINT "return_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "boxes" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "length_in" DECIMAL(8,2) NOT NULL,
    "width_in" DECIMAL(8,2) NOT NULL,
    "height_in" DECIMAL(8,2) NOT NULL,
    "outer_length_in" DECIMAL(8,2),
    "outer_width_in" DECIMAL(8,2),
    "outer_height_in" DECIMAL(8,2),
    "tare_weight_oz" DECIMAL(10,2),
    "max_weight_oz" DECIMAL(10,2),
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "boxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "packages" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "box_id" UUID,
    "weight_oz" DECIMAL(10,2),
    "weight_override_reason" TEXT,
    "length_in" DECIMAL(8,2),
    "width_in" DECIMAL(8,2),
    "height_in" DECIMAL(8,2),
    "shipstation_shipment_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "package_items" (
    "id" UUID NOT NULL,
    "package_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "packed_by_id" UUID,
    "packed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "qa_verified_by_id" UUID,
    "qa_verified_at" TIMESTAMPTZ(3),
    "lot_code" TEXT,
    "lumexia_lot_id" TEXT,

    CONSTRAINT "package_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipping_carriers" (
    "id" UUID NOT NULL,
    "shipstation_carrier_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nickname" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shipping_carriers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carrier_services" (
    "id" UUID NOT NULL,
    "carrier_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domestic" BOOLEAN NOT NULL,
    "international" BOOLEAN NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "carrier_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipping_rates" (
    "id" UUID NOT NULL,
    "package_id" UUID NOT NULL,
    "shipstation_rate_id" TEXT NOT NULL,
    "carrier_code" TEXT NOT NULL,
    "service_code" TEXT NOT NULL,
    "service_name" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "delivery_days" INTEGER,
    "estimated_delivery_at" TIMESTAMPTZ(3),
    "guaranteed" BOOLEAN NOT NULL DEFAULT false,
    "trackable" BOOLEAN NOT NULL DEFAULT true,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "fetched_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3),

    CONSTRAINT "shipping_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipping_labels" (
    "id" UUID NOT NULL,
    "package_id" UUID,
    "return_id" UUID,
    "status" "label_status" NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "shipstation_label_id" TEXT,
    "shipstation_shipment_id" TEXT,
    "tracking_number" TEXT,
    "carrier_code" TEXT NOT NULL,
    "service_code" TEXT NOT NULL,
    "cost_cents" INTEGER,
    "currency" CHAR(3) NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'pdf',
    "pdf_url" TEXT,
    "png_url" TEXT,
    "ship_date" DATE,
    "error" TEXT,
    "purchased_by_id" UUID,
    "purchased_at" TIMESTAMPTZ(3),
    "print_count" INTEGER NOT NULL DEFAULT 0,
    "last_printed_at" TIMESTAMPTZ(3),
    "voided_by_id" UUID,
    "void_requested_at" TIMESTAMPTZ(3),
    "voided_at" TIMESTAMPTZ(3),
    "void_reason" TEXT,
    "manifest_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shipping_labels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manifests" (
    "id" UUID NOT NULL,
    "carrier_id" UUID NOT NULL,
    "shipstation_manifest_id" TEXT NOT NULL,
    "ship_date" DATE NOT NULL,
    "form_url" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manifests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "ship_from_address" JSONB,
    "woo_store_url" TEXT,
    "woo_consumer_key_enc" TEXT,
    "woo_consumer_secret_enc" TEXT,
    "woo_webhook_secret_enc" TEXT,
    "shipstation_api_key_enc" TEXT,
    "lumexia_base_url" TEXT,
    "lumexia_api_key_enc" TEXT,
    "sync_interval_minutes" INTEGER NOT NULL DEFAULT 5,
    "station_idle_lock_minutes" INTEGER NOT NULL DEFAULT 10,
    "qa_must_differ_from_packer" BOOLEAN NOT NULL DEFAULT false,
    "weight_display" "weight_display" NOT NULL DEFAULT 'LB_OZ',
    "stage_sla_minutes" JSONB NOT NULL DEFAULT '{}',
    "pii_retention_days" INTEGER,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_runs" (
    "id" UUID NOT NULL,
    "type" "sync_type" NOT NULL,
    "status" "sync_status" NOT NULL DEFAULT 'RUNNING',
    "records_processed" INTEGER NOT NULL DEFAULT 0,
    "records_failed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_run_errors" (
    "id" UUID NOT NULL,
    "sync_run_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "error" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_run_errors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_webhooks" (
    "id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),
    "error" TEXT,

    CONSTRAINT "inbound_webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "station_id" UUID,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "request_id" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotent_requests" (
    "key" TEXT NOT NULL,
    "user_id" UUID,
    "procedure" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotent_requests_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_badge_code_key" ON "users"("badge_code");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "accounts_user_id_idx" ON "accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_provider_id_account_id_key" ON "accounts"("provider_id", "account_id");

-- CreateIndex
CREATE INDEX "verifications_identifier_idx" ON "verifications"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_email_key" ON "invitations"("email");

-- CreateIndex
CREATE UNIQUE INDEX "stations_name_key" ON "stations"("name");

-- CreateIndex
CREATE UNIQUE INDEX "stations_token_hash_key" ON "stations"("token_hash");

-- CreateIndex
CREATE INDEX "station_activations_station_id_ended_at_idx" ON "station_activations"("station_id", "ended_at");

-- CreateIndex
CREATE UNIQUE INDEX "products_woo_product_id_key" ON "products"("woo_product_id");

-- CreateIndex
CREATE INDEX "products_sku_idx" ON "products"("sku");

-- CreateIndex
CREATE INDEX "products_barcode_idx" ON "products"("barcode");

-- CreateIndex
CREATE UNIQUE INDEX "product_variations_woo_variation_id_key" ON "product_variations"("woo_variation_id");

-- CreateIndex
CREATE INDEX "product_variations_product_id_idx" ON "product_variations"("product_id");

-- CreateIndex
CREATE INDEX "product_variations_sku_idx" ON "product_variations"("sku");

-- CreateIndex
CREATE INDEX "product_variations_barcode_idx" ON "product_variations"("barcode");

-- CreateIndex
CREATE UNIQUE INDEX "orders_woo_order_id_key" ON "orders"("woo_order_id");

-- CreateIndex
CREATE INDEX "orders_status_priority_ordered_at_idx" ON "orders"("status", "priority" DESC, "ordered_at");

-- CreateIndex
CREATE INDEX "orders_number_idx" ON "orders"("number");

-- CreateIndex
CREATE INDEX "orders_customer_name_idx" ON "orders"("customer_name");

-- CreateIndex
CREATE UNIQUE INDEX "order_items_woo_line_item_id_key" ON "order_items"("woo_line_item_id");

-- CreateIndex
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");

-- CreateIndex
CREATE INDEX "order_stage_events_order_id_at_idx" ON "order_stage_events"("order_id", "at");

-- CreateIndex
CREATE INDEX "order_stage_events_to_status_at_idx" ON "order_stage_events"("to_status", "at");

-- CreateIndex
CREATE INDEX "item_voids_order_id_idx" ON "item_voids"("order_id");

-- CreateIndex
CREATE INDEX "item_voids_resolved_at_idx" ON "item_voids"("resolved_at");

-- CreateIndex
CREATE INDEX "notes_order_id_idx" ON "notes"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "note_attachments_storage_key_key" ON "note_attachments"("storage_key");

-- CreateIndex
CREATE INDEX "note_attachments_note_id_idx" ON "note_attachments"("note_id");

-- CreateIndex
CREATE INDEX "quality_issues_order_id_idx" ON "quality_issues"("order_id");

-- CreateIndex
CREATE INDEX "quality_issues_status_severity_idx" ON "quality_issues"("status", "severity");

-- CreateIndex
CREATE INDEX "quality_issues_created_at_idx" ON "quality_issues"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "return_requests_rma_number_key" ON "return_requests"("rma_number");

-- CreateIndex
CREATE INDEX "return_requests_order_id_idx" ON "return_requests"("order_id");

-- CreateIndex
CREATE INDEX "return_requests_status_idx" ON "return_requests"("status");

-- CreateIndex
CREATE INDEX "return_items_return_id_idx" ON "return_items"("return_id");

-- CreateIndex
CREATE UNIQUE INDEX "boxes_name_key" ON "boxes"("name");

-- CreateIndex
CREATE UNIQUE INDEX "packages_order_id_number_key" ON "packages"("order_id", "number");

-- CreateIndex
CREATE INDEX "package_items_package_id_idx" ON "package_items"("package_id");

-- CreateIndex
CREATE INDEX "package_items_order_item_id_idx" ON "package_items"("order_item_id");

-- CreateIndex
CREATE INDEX "package_items_lot_code_idx" ON "package_items"("lot_code");

-- CreateIndex
CREATE UNIQUE INDEX "shipping_carriers_shipstation_carrier_id_key" ON "shipping_carriers"("shipstation_carrier_id");

-- CreateIndex
CREATE UNIQUE INDEX "carrier_services_carrier_id_code_key" ON "carrier_services"("carrier_id", "code");

-- CreateIndex
CREATE INDEX "shipping_rates_package_id_idx" ON "shipping_rates"("package_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipping_labels_idempotency_key_key" ON "shipping_labels"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "shipping_labels_shipstation_label_id_key" ON "shipping_labels"("shipstation_label_id");

-- CreateIndex
CREATE INDEX "shipping_labels_package_id_idx" ON "shipping_labels"("package_id");

-- CreateIndex
CREATE INDEX "shipping_labels_tracking_number_idx" ON "shipping_labels"("tracking_number");

-- CreateIndex
CREATE INDEX "shipping_labels_status_idx" ON "shipping_labels"("status");

-- CreateIndex
CREATE UNIQUE INDEX "manifests_shipstation_manifest_id_key" ON "manifests"("shipstation_manifest_id");

-- CreateIndex
CREATE INDEX "sync_runs_type_started_at_idx" ON "sync_runs"("type", "started_at" DESC);

-- CreateIndex
CREATE INDEX "sync_run_errors_sync_run_id_idx" ON "sync_run_errors"("sync_run_id");

-- CreateIndex
CREATE INDEX "inbound_webhooks_processed_at_idx" ON "inbound_webhooks"("processed_at");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_webhooks_source_delivery_id_key" ON "inbound_webhooks"("source", "delivery_id");

-- CreateIndex
CREATE INDEX "audit_events_entity_type_entity_id_at_idx" ON "audit_events"("entity_type", "entity_id", "at");

-- CreateIndex
CREATE INDEX "audit_events_actor_id_at_idx" ON "audit_events"("actor_id", "at");

-- CreateIndex
CREATE INDEX "idempotent_requests_created_at_idx" ON "idempotent_requests"("created_at");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stations" ADD CONSTRAINT "stations_registered_by_id_fkey" FOREIGN KEY ("registered_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "station_activations" ADD CONSTRAINT "station_activations_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "stations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "station_activations" ADD CONSTRAINT "station_activations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variations" ADD CONSTRAINT "product_variations_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_claimed_by_id_fkey" FOREIGN KEY ("claimed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variation_id_fkey" FOREIGN KEY ("variation_id") REFERENCES "product_variations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_bundle_parent_id_fkey" FOREIGN KEY ("bundle_parent_id") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_picked_by_id_fkey" FOREIGN KEY ("picked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_stage_events" ADD CONSTRAINT "order_stage_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_stage_events" ADD CONSTRAINT "order_stage_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_stage_events" ADD CONSTRAINT "order_stage_events_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_voids" ADD CONSTRAINT "item_voids_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_voids" ADD CONSTRAINT "item_voids_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_voids" ADD CONSTRAINT "item_voids_voided_by_id_fkey" FOREIGN KEY ("voided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_voids" ADD CONSTRAINT "item_voids_undone_by_id_fkey" FOREIGN KEY ("undone_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_voids" ADD CONSTRAINT "item_voids_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_quality_issue_id_fkey" FOREIGN KEY ("quality_issue_id") REFERENCES "quality_issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "return_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_attachments" ADD CONSTRAINT "note_attachments_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_issues" ADD CONSTRAINT "quality_issues_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_issues" ADD CONSTRAINT "quality_issues_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_issues" ADD CONSTRAINT "quality_issues_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "packages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_issues" ADD CONSTRAINT "quality_issues_label_id_fkey" FOREIGN KEY ("label_id") REFERENCES "shipping_labels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_issues" ADD CONSTRAINT "quality_issues_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_issues" ADD CONSTRAINT "quality_issues_responsible_user_id_fkey" FOREIGN KEY ("responsible_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_issues" ADD CONSTRAINT "quality_issues_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_quality_issue_id_fkey" FOREIGN KEY ("quality_issue_id") REFERENCES "quality_issues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "return_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packages" ADD CONSTRAINT "packages_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packages" ADD CONSTRAINT "packages_box_id_fkey" FOREIGN KEY ("box_id") REFERENCES "boxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_items" ADD CONSTRAINT "package_items_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_items" ADD CONSTRAINT "package_items_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_items" ADD CONSTRAINT "package_items_packed_by_id_fkey" FOREIGN KEY ("packed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_items" ADD CONSTRAINT "package_items_qa_verified_by_id_fkey" FOREIGN KEY ("qa_verified_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_services" ADD CONSTRAINT "carrier_services_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "shipping_carriers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_rates" ADD CONSTRAINT "shipping_rates_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_labels" ADD CONSTRAINT "shipping_labels_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_labels" ADD CONSTRAINT "shipping_labels_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "return_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_labels" ADD CONSTRAINT "shipping_labels_purchased_by_id_fkey" FOREIGN KEY ("purchased_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_labels" ADD CONSTRAINT "shipping_labels_voided_by_id_fkey" FOREIGN KEY ("voided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_labels" ADD CONSTRAINT "shipping_labels_manifest_id_fkey" FOREIGN KEY ("manifest_id") REFERENCES "manifests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manifests" ADD CONSTRAINT "manifests_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "shipping_carriers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manifests" ADD CONSTRAINT "manifests_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_run_errors" ADD CONSTRAINT "sync_run_errors_sync_run_id_fkey" FOREIGN KEY ("sync_run_id") REFERENCES "sync_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotent_requests" ADD CONSTRAINT "idempotent_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written constraints Prisma can't express. Keep these when regenerating.
-- ---------------------------------------------------------------------------

-- Settings is a single row.
ALTER TABLE "settings" ADD CONSTRAINT "settings_singleton" CHECK ("id" = 1);

-- A label belongs to exactly one of: a package, a return.
ALTER TABLE "shipping_labels" ADD CONSTRAINT "shipping_labels_one_owner"
  CHECK (num_nonnulls("package_id", "return_id") = 1);

-- At most one live (not failed/voided) label per package.
CREATE UNIQUE INDEX "shipping_labels_one_live_per_package"
  ON "shipping_labels" ("package_id")
  WHERE "package_id" IS NOT NULL AND "status" IN ('PURCHASING', 'ACTIVE', 'VOID_REQUESTED', 'VOID_REJECTED');

-- At most one selected rate per package.
CREATE UNIQUE INDEX "shipping_rates_one_selected_per_package"
  ON "shipping_rates" ("package_id") WHERE "selected";

-- A note targets the order plus at most one narrower thing.
ALTER TABLE "notes" ADD CONSTRAINT "notes_single_target"
  CHECK (num_nonnulls("order_item_id", "package_id", "quality_issue_id", "return_id") <= 1);

-- Quantities are positive.
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_picked_quantity_range"
  CHECK ("picked_quantity" >= 0 AND "picked_quantity" <= "quantity");
ALTER TABLE "package_items" ADD CONSTRAINT "package_items_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "item_voids" ADD CONSTRAINT "item_voids_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_quantity_positive" CHECK ("quantity" > 0);

-- Weights and dimensions are positive when present.
ALTER TABLE "boxes" ADD CONSTRAINT "boxes_dimensions_positive"
  CHECK ("length_in" > 0 AND "width_in" > 0 AND "height_in" > 0);
ALTER TABLE "packages" ADD CONSTRAINT "packages_weight_positive" CHECK ("weight_oz" IS NULL OR "weight_oz" > 0);
