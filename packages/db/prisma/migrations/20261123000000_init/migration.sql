-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "account_kind" AS ENUM ('fiat_clearing', 'user_available', 'user_held', 'user_incoming');

-- CreateEnum
CREATE TYPE "posting_side" AS ENUM ('debit', 'credit');

-- CreateEnum
CREATE TYPE "journal_kind" AS ENUM ('reserve', 'settle', 'reverse');

-- CreateEnum
CREATE TYPE "operation_type" AS ENUM ('deposit', 'withdrawal', 'transfer');

-- CreateEnum
CREATE TYPE "operation_status" AS ENUM ('requested', 'ledger_reserved', 'submitted', 'confirmed', 'failed', 'reversed');

-- CreateEnum
CREATE TYPE "failure_reason" AS ENUM ('reverted', 'dropped', 'compliance_rejected', 'duplicate_reference', 'reference_conflict', 'retries_exhausted', 'rejected');

-- CreateEnum
CREATE TYPE "signer_name" AS ENUM ('settlement', 'compliance');

-- CreateEnum
CREATE TYPE "outbox_status" AS ENUM ('pending', 'processing', 'done', 'dead');

-- CreateEnum
CREATE TYPE "attempt_status" AS ENUM ('signed', 'sent', 'mined', 'reverted', 'dropped', 'replaced');

-- CreateEnum
CREATE TYPE "compliance_action" AS ENUM ('verify', 'unverify', 'freeze', 'unfreeze');

-- CreateEnum
CREATE TYPE "compliance_change_status" AS ENUM ('requested', 'submitted', 'confirmed', 'failed');

-- CreateEnum
CREATE TYPE "chain_event_kind" AS ENUM ('Minted', 'Burned', 'SettledTransfer', 'Transfer', 'VerificationSet', 'FrozenSet');

-- CreateEnum
CREATE TYPE "reconciliation_status" AS ENUM ('ok', 'mismatch');

-- CreateTable
CREATE TABLE "deployment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "chain_id" BIGINT NOT NULL,
    "token_address" TEXT NOT NULL,
    "registry_address" TEXT NOT NULL,
    "deployment_block" BIGINT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_user" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "wallet_address" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "frozen" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" "account_kind" NOT NULL,
    "user_id" UUID,
    "guard_version" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "deployment_id" UUID NOT NULL,
    "type" "operation_type" NOT NULL,
    "status" "operation_status" NOT NULL DEFAULT 'requested',
    "user_id" UUID NOT NULL,
    "counterparty_user_id" UUID,
    "amount" BIGINT NOT NULL,
    "ref" TEXT NOT NULL,
    "confirmed_block" BIGINT,
    "failure_reason" "failure_reason",
    "resubmits_so_far" INTEGER NOT NULL DEFAULT 0,
    "idempotency_key" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "operation_id" UUID NOT NULL,
    "kind" "journal_kind" NOT NULL,
    "sealed_tx" xid8 NOT NULL DEFAULT pg_current_xact_id(),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "posting" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entry_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "side" "posting_side" NOT NULL,
    "amount" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "posting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_message" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "deployment_id" UUID NOT NULL,
    "signer" "signer_name" NOT NULL,
    "call" JSONB NOT NULL,
    "ref" TEXT NOT NULL,
    "operation_id" UUID,
    "compliance_change_id" UUID,
    "status" "outbox_status" NOT NULL DEFAULT 'pending',
    "attempts_count" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMPTZ(6),
    "locked_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "outbox_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signer_state" (
    "deployment_id" UUID NOT NULL,
    "signer" "signer_name" NOT NULL,
    "address" TEXT NOT NULL,

    CONSTRAINT "signer_state_pkey" PRIMARY KEY ("deployment_id","signer")
);

-- CreateTable
CREATE TABLE "chain_attempt" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "deployment_id" UUID NOT NULL,
    "outbox_id" UUID NOT NULL,
    "signer" "signer_name" NOT NULL,
    "nonce" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "raw_transaction" TEXT NOT NULL,
    "max_fee_per_gas" BIGINT NOT NULL,
    "max_priority_fee_per_gas" BIGINT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "status" "attempt_status" NOT NULL DEFAULT 'signed',
    "block_number" BIGINT,
    "block_hash" TEXT,
    "bumps_so_far" INTEGER NOT NULL DEFAULT 0,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_checked_at" TIMESTAMPTZ(6),

    CONSTRAINT "chain_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_change" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "deployment_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "action" "compliance_action" NOT NULL,
    "ref" TEXT NOT NULL,
    "status" "compliance_change_status" NOT NULL DEFAULT 'requested',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_change_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "indexed_block" (
    "deployment_id" UUID NOT NULL,
    "number" BIGINT NOT NULL,
    "hash" TEXT NOT NULL,
    "parent_hash" TEXT NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "indexed_block_pkey" PRIMARY KEY ("deployment_id","number")
);

-- CreateTable
CREATE TABLE "indexer_state" (
    "deployment_id" UUID NOT NULL,
    "last_indexed_block" BIGINT NOT NULL,

    CONSTRAINT "indexer_state_pkey" PRIMARY KEY ("deployment_id")
);

-- CreateTable
CREATE TABLE "chain_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "deployment_id" UUID NOT NULL,
    "block_number" BIGINT NOT NULL,
    "block_hash" TEXT NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "log_index" INTEGER NOT NULL,
    "kind" "chain_event_kind" NOT NULL,
    "from_address" TEXT,
    "to_address" TEXT,
    "account" TEXT,
    "amount" DECIMAL(78,0),
    "ref" TEXT,
    "flag_value" BOOLEAN,

    CONSTRAINT "chain_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_run" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "deployment_id" UUID NOT NULL,
    "at_block" BIGINT NOT NULL,
    "final_block" BIGINT NOT NULL,
    "status" "reconciliation_status" NOT NULL,
    "mismatches" JSONB NOT NULL DEFAULT '[]',
    "summary" JSONB NOT NULL DEFAULT '{}',
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "reconciliation_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "from_state" TEXT,
    "to_state" TEXT NOT NULL,
    "tx_hash" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "deployment_chain_id_token_address_key" ON "deployment"("chain_id", "token_address");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_wallet_address_key" ON "app_user"("wallet_address");

-- CreateIndex
CREATE UNIQUE INDEX "account_kind_user_id_key" ON "account"("kind", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "operation_idempotency_key_key" ON "operation"("idempotency_key");

-- CreateIndex
CREATE INDEX "operation_user_id_idx" ON "operation"("user_id");

-- CreateIndex
CREATE INDEX "operation_counterparty_user_id_idx" ON "operation"("counterparty_user_id");

-- CreateIndex
CREATE INDEX "operation_deployment_id_status_idx" ON "operation"("deployment_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "operation_deployment_id_ref_key" ON "operation"("deployment_id", "ref");

-- CreateIndex
CREATE UNIQUE INDEX "operation_id_deployment_id_ref_key" ON "operation"("id", "deployment_id", "ref");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entry_operation_id_kind_key" ON "journal_entry"("operation_id", "kind");

-- CreateIndex
CREATE INDEX "posting_entry_id_idx" ON "posting"("entry_id");

-- CreateIndex
CREATE INDEX "posting_account_id_idx" ON "posting"("account_id");

-- CreateIndex
CREATE INDEX "outbox_message_status_available_at_idx" ON "outbox_message"("status", "available_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_message_deployment_id_ref_key" ON "outbox_message"("deployment_id", "ref");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_message_id_deployment_id_signer_ref_key" ON "outbox_message"("id", "deployment_id", "signer", "ref");

-- CreateIndex
CREATE UNIQUE INDEX "chain_attempt_hash_key" ON "chain_attempt"("hash");

-- CreateIndex
CREATE INDEX "chain_attempt_outbox_id_idx" ON "chain_attempt"("outbox_id");

-- CreateIndex
CREATE INDEX "chain_attempt_deployment_id_signer_nonce_idx" ON "chain_attempt"("deployment_id", "signer", "nonce");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_change_deployment_id_ref_key" ON "compliance_change"("deployment_id", "ref");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_change_id_deployment_id_ref_key" ON "compliance_change"("id", "deployment_id", "ref");

-- CreateIndex
CREATE UNIQUE INDEX "indexed_block_deployment_id_number_hash_key" ON "indexed_block"("deployment_id", "number", "hash");

-- CreateIndex
CREATE INDEX "chain_event_deployment_id_block_number_idx" ON "chain_event"("deployment_id", "block_number");

-- CreateIndex
CREATE INDEX "chain_event_deployment_id_ref_idx" ON "chain_event"("deployment_id", "ref");

-- CreateIndex
CREATE UNIQUE INDEX "chain_event_deployment_id_block_hash_log_index_key" ON "chain_event"("deployment_id", "block_hash", "log_index");

-- CreateIndex
CREATE INDEX "reconciliation_run_deployment_id_started_at_idx" ON "reconciliation_run"("deployment_id", "started_at");

-- CreateIndex
CREATE INDEX "audit_log_entity_entity_id_idx" ON "audit_log"("entity", "entity_id");

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "operation" ADD CONSTRAINT "operation_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "operation" ADD CONSTRAINT "operation_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "operation" ADD CONSTRAINT "operation_counterparty_user_id_fkey" FOREIGN KEY ("counterparty_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "operation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "posting" ADD CONSTRAINT "posting_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "journal_entry"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "posting" ADD CONSTRAINT "posting_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "outbox_message" ADD CONSTRAINT "outbox_message_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "outbox_message" ADD CONSTRAINT "outbox_message_operation_id_deployment_id_ref_fkey" FOREIGN KEY ("operation_id", "deployment_id", "ref") REFERENCES "operation"("id", "deployment_id", "ref") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "outbox_message" ADD CONSTRAINT "outbox_message_compliance_change_id_deployment_id_ref_fkey" FOREIGN KEY ("compliance_change_id", "deployment_id", "ref") REFERENCES "compliance_change"("id", "deployment_id", "ref") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "signer_state" ADD CONSTRAINT "signer_state_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "chain_attempt" ADD CONSTRAINT "chain_attempt_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "chain_attempt" ADD CONSTRAINT "chain_attempt_outbox_id_deployment_id_signer_ref_fkey" FOREIGN KEY ("outbox_id", "deployment_id", "signer", "ref") REFERENCES "outbox_message"("id", "deployment_id", "signer", "ref") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "compliance_change" ADD CONSTRAINT "compliance_change_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "compliance_change" ADD CONSTRAINT "compliance_change_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "indexed_block" ADD CONSTRAINT "indexed_block_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "indexer_state" ADD CONSTRAINT "indexer_state_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "chain_event" ADD CONSTRAINT "chain_event_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "chain_event" ADD CONSTRAINT "chain_event_deployment_id_block_number_block_hash_fkey" FOREIGN KEY ("deployment_id", "block_number", "block_hash") REFERENCES "indexed_block"("deployment_id", "number", "hash") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reconciliation_run" ADD CONSTRAINT "reconciliation_run_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

