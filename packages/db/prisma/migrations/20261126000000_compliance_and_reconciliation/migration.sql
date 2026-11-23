-- =================================================================================================
-- Engine piece C: compliance sending and the reconciler. Hand-written; additive only (no earlier
-- migration is edited, no existing guard is weakened).
--
-- 1. compliance_change gets what a sender needs: who asked and with which idempotency key (unique
--    per requester), why, a version for optimistic fencing, a resubmission counter, the block the
--    registry applied it in, and why it failed. Identity (now including requester, key, reason)
--    stays immutable; the version and the counter never go down; the block, once set, never moves.
-- 2. reconciliation_run can record an UNKNOWN run (a read failed: never a clean pass), the head it
--    was taken from, the error, and its mismatch count; runs are sealed once written.
-- 3. reconciliation_mismatch: one row per mismatch of a run, an exact projection of the run's
--    `mismatches` array, append-only, and the count is checked at COMMIT.
--
-- Note: `ALTER TYPE ... ADD VALUE` cannot be USED in the transaction that adds it, so every guard
-- below compares `status::text` with a literal instead of the enum value 'unknown'.
-- =================================================================================================

-- -------------------------------------------------------------------------------------------------
-- 1. compliance_change
-- -------------------------------------------------------------------------------------------------

ALTER TABLE "compliance_change"
  ADD COLUMN "requested_by" TEXT,
  ADD COLUMN "idempotency_key" TEXT,
  ADD COLUMN "reason" TEXT,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "resubmits_so_far" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "confirmed_block" BIGINT,
  ADD COLUMN "failure_reason" "failure_reason",
  ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Stops: two requests of one operator with one key both creating a change (a retried admin click
-- freezing twice, or worse, a "verify" retried after the operator changed it to "unverify"). The
-- key names a request of ONE requester, as for operations.
CREATE UNIQUE INDEX "compliance_change_requested_by_idempotency_key_key"
  ON "compliance_change"("requested_by", "idempotency_key");

ALTER TABLE compliance_change
  ADD CONSTRAINT compliance_change_requested_by_length
    CHECK (requested_by IS NULL OR length(requested_by) BETWEEN 1 AND 255),
  ADD CONSTRAINT compliance_change_idempotency_key_length
    CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 255),
  -- A key without a requester could collide across operators; a requester without a key cannot
  -- be replayed safely.
  ADD CONSTRAINT compliance_change_key_with_requester
    CHECK ((requested_by IS NULL) = (idempotency_key IS NULL)),
  ADD CONSTRAINT compliance_change_reason_length
    CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  ADD CONSTRAINT compliance_change_version_non_negative CHECK (version >= 0),
  ADD CONSTRAINT compliance_change_resubmits_non_negative CHECK (resubmits_so_far >= 0),
  ADD CONSTRAINT compliance_change_confirmed_block_non_negative
    CHECK (confirmed_block IS NULL OR confirmed_block >= 0),
  -- The block is recorded only for an applied change; a failure reason only once something failed
  -- (a late confirmation keeps it as history).
  ADD CONSTRAINT compliance_change_confirmed_block_only_when_confirmed
    CHECK (confirmed_block IS NULL OR status = 'confirmed'),
  ADD CONSTRAINT compliance_change_failure_reason_only_after_failure
    CHECK (failure_reason IS NULL OR status IN ('failed', 'confirmed'));

-- Replaces the 6f update guard: the same legal transitions, plus the new identity columns, a
-- version and counter that never go down, and a confirmed block that never moves once recorded.
-- Stops: rewriting who asked for a change or why (the compliance history is evidence), and a
-- stale writer "rolling back" the version that fences concurrent moves.
CREATE OR REPLACE FUNCTION trg_compliance_change_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.action IS DISTINCT FROM OLD.action OR NEW.ref IS DISTINCT FROM OLD.ref
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR (OLD.confirmed_block IS NOT NULL AND NEW.confirmed_block IS DISTINCT FROM OLD.confirmed_block) THEN
    RAISE EXCEPTION 'compliance_immutable: compliance change % identity cannot change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version < OLD.version OR NEW.resubmits_so_far < OLD.resubmits_so_far THEN
    RAISE EXCEPTION 'compliance_version: compliance change % version and resubmits never decrease', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((OLD.status::text || '>' || NEW.status::text) = ANY (ARRAY[
      'requested>submitted',
      'requested>failed',
      'submitted>submitted',
      'submitted>confirmed',
      'submitted>failed',
      'failed>confirmed'])) THEN
    RAISE EXCEPTION 'compliance_transition: % -> % is not a legal transition for compliance change %',
      OLD.status, NEW.status, OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- -------------------------------------------------------------------------------------------------
-- 2. reconciliation_run: unknown runs, sealed rows
-- -------------------------------------------------------------------------------------------------

ALTER TYPE "reconciliation_status" ADD VALUE 'unknown';

ALTER TABLE "reconciliation_run"
  ADD COLUMN "head_block" BIGINT,
  ADD COLUMN "mismatch_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "error" TEXT,
  ALTER COLUMN "at_block" DROP NOT NULL,
  ALTER COLUMN "final_block" DROP NOT NULL;

ALTER TABLE reconciliation_run
  -- Stops: a run that could not read something being stored as a clean pass. An unknown run says
  -- why; a compared run never carries an error.
  ADD CONSTRAINT reconciliation_unknown_has_error
    CHECK ((status::text = 'unknown') = (error IS NOT NULL)),
  ADD CONSTRAINT reconciliation_error_length
    CHECK (error IS NULL OR length(error) BETWEEN 1 AND 1000),
  -- A compared run names the blocks it compared at.
  ADD CONSTRAINT reconciliation_compared_has_blocks
    CHECK (status::text = 'unknown' OR (at_block IS NOT NULL AND final_block IS NOT NULL)),
  ADD CONSTRAINT reconciliation_head_non_negative CHECK (head_block IS NULL OR head_block >= 0),
  -- ok <=> zero mismatches; mismatch <=> at least one; unknown compares nothing.
  ADD CONSTRAINT reconciliation_count_matches_status
    CHECK ((status::text = 'mismatch') = (mismatch_count > 0) AND mismatch_count >= 0),
  -- The stored array and the count agree (CASE: the array-type CHECK reports a non-array first).
  ADD CONSTRAINT reconciliation_count_matches_array
    CHECK (CASE WHEN jsonb_typeof(mismatches) = 'array'
                THEN jsonb_array_length(mismatches) = mismatch_count ELSE true END);

-- Stops: editing or deleting a run after the fact (a "fixed" report hides what was seen). Named
-- to sort after reconciliation_run_deployment_bound so a rebind still reports deployment_rebind.
CREATE TRIGGER reconciliation_run_sealed
  BEFORE UPDATE OR DELETE ON reconciliation_run FOR EACH ROW EXECUTE FUNCTION trg_forbid_change();
CREATE TRIGGER reconciliation_run_sealed_truncate
  BEFORE TRUNCATE ON reconciliation_run FOR EACH STATEMENT EXECUTE FUNCTION trg_forbid_change();

-- -------------------------------------------------------------------------------------------------
-- 3. reconciliation_mismatch
-- -------------------------------------------------------------------------------------------------

CREATE TABLE "reconciliation_mismatch" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_mismatch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "reconciliation_mismatch_run_id_ordinal_key"
  ON "reconciliation_mismatch"("run_id", "ordinal");
CREATE INDEX "reconciliation_mismatch_kind_idx" ON "reconciliation_mismatch"("kind");

ALTER TABLE "reconciliation_mismatch" ADD CONSTRAINT "reconciliation_mismatch_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "reconciliation_run"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE reconciliation_mismatch
  ADD CONSTRAINT reconciliation_mismatch_ordinal_non_negative CHECK (ordinal >= 0),
  ADD CONSTRAINT reconciliation_mismatch_detail_is_object CHECK (jsonb_typeof(detail) = 'object'),
  -- The domain's mismatch kinds, and the row's kind is the one its detail carries.
  ADD CONSTRAINT reconciliation_mismatch_kind_known CHECK (kind IN (
    'missing_onchain', 'amount_mismatch', 'address_mismatch', 'confirmed_block_mismatch',
    'unexpected_onchain_event', 'unexplained_transfer', 'balance_mismatch', 'supply_mismatch',
    'compliance_event_mismatch', 'compliance_mismatch')),
  ADD CONSTRAINT reconciliation_mismatch_kind_matches_detail CHECK (detail->>'kind' = kind);

-- Stops: a mismatch row that is not in its run's report (added later, edited on the way in, or
-- attached to a clean run). Each row must equal the run's array element at its ordinal.
CREATE FUNCTION trg_reconciliation_mismatch_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected jsonb;
BEGIN
  SELECT r.mismatches -> NEW.ordinal INTO expected
    FROM reconciliation_run r
   WHERE r.id = NEW.run_id AND r.status::text = 'mismatch';
  IF expected IS NULL OR expected IS DISTINCT FROM NEW.detail THEN
    RAISE EXCEPTION 'reconciliation_mismatch_foreign: mismatch % of run % is not in that run''s report',
      NEW.ordinal, NEW.run_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER reconciliation_mismatch_insert
  BEFORE INSERT ON reconciliation_mismatch
  FOR EACH ROW EXECUTE FUNCTION trg_reconciliation_mismatch_insert();

CREATE TRIGGER reconciliation_mismatch_append_only
  BEFORE UPDATE OR DELETE ON reconciliation_mismatch FOR EACH ROW EXECUTE FUNCTION trg_forbid_change();
CREATE TRIGGER reconciliation_mismatch_no_truncate
  BEFORE TRUNCATE ON reconciliation_mismatch FOR EACH STATEMENT EXECUTE FUNCTION trg_forbid_change();

-- Stops: a run whose mismatch rows are missing (written without them, or with only some). Checked
-- at COMMIT, so the run and its rows are written in one transaction or not at all.
CREATE FUNCTION trg_reconciliation_run_complete() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_run uuid;
  want integer;
  have integer;
BEGIN
  -- Two statements, not a CASE: NEW has only the firing table's columns.
  IF TG_TABLE_NAME = 'reconciliation_run' THEN
    v_run := NEW.id;
  ELSE
    v_run := NEW.run_id;
  END IF;
  SELECT r.mismatch_count INTO want FROM reconciliation_run r WHERE r.id = v_run;
  SELECT count(*) INTO have FROM reconciliation_mismatch m WHERE m.run_id = v_run;
  IF want IS DISTINCT FROM have THEN
    RAISE EXCEPTION 'reconciliation_incomplete: run % records % mismatch(es) but has % row(s)',
      v_run, want, have
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER reconciliation_run_complete
  AFTER INSERT ON reconciliation_run DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trg_reconciliation_run_complete();
CREATE CONSTRAINT TRIGGER reconciliation_mismatch_complete
  AFTER INSERT ON reconciliation_mismatch DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trg_reconciliation_run_complete();
