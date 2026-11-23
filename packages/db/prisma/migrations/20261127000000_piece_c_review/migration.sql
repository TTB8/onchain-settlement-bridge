-- =================================================================================================
-- Fixes from the independent review of engine piece C. Hand-written; additive only.
--
-- 1. compliance_change.decision_seq: a database-assigned, monotonic, immutable, unique order of
--    the bridge's DECISIONS (review M-1). The reconciler's "latest confirmed decision" must not
--    depend on the application clock (`created_at` can tie, or move backwards across workers).
-- 2. A compliance change starts at version 0 with no resubmissions, like an operation.
-- 3. app_user.wallet_address is immutable (review L-4), like signer_state.address.
-- =================================================================================================

-- -------------------------------------------------------------------------------------------------
-- 1. Stops: two decisions for one account and flag ordered by a clock that ties or drifts, so
--    the reconciler could treat the older one as the latest. A sequence orders them by the moment
--    the database recorded them. Existing rows get values in physical order when the column is
--    added (they predate the reconciler).
-- -------------------------------------------------------------------------------------------------

ALTER TABLE "compliance_change" ADD COLUMN "decision_seq" BIGSERIAL NOT NULL;
CREATE UNIQUE INDEX "compliance_change_decision_seq_key" ON "compliance_change"("decision_seq");

-- Replaces the insert guard: the same checks (starts requested, active deployment held FOR SHARE),
-- plus version 0 / resubmits 0, and the sequence value is ALWAYS assigned here: a client-supplied
-- decision_seq (to jump the queue, or to look older than another decision) is overwritten.
CREATE OR REPLACE FUNCTION trg_compliance_change_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'requested' THEN
    RAISE EXCEPTION 'compliance_transition: a compliance change starts as requested, not %', NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <> 0 OR NEW.resubmits_so_far <> 0 THEN
    RAISE EXCEPTION 'compliance_version: a new compliance change starts at version 0 with no resubmits'
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM 1 FROM deployment WHERE id = NEW.deployment_id AND active FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deployment_inactive: deployment % is not active', NEW.deployment_id
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.decision_seq := nextval(pg_get_serial_sequence('compliance_change', 'decision_seq'));
  RETURN NEW;
END $$;

-- Replaces the update guard: decision_seq joins the identity columns.
CREATE OR REPLACE FUNCTION trg_compliance_change_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.action IS DISTINCT FROM OLD.action OR NEW.ref IS DISTINCT FROM OLD.ref
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.decision_seq IS DISTINCT FROM OLD.decision_seq
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
-- 3. Stops: re-pointing a user at another wallet. Every operation, compliance change and ledger
--    expectation names the user's address on chain; changing it would make the registry and the
--    token history silently belong to someone else. A new wallet is a new user (and a migration).
-- -------------------------------------------------------------------------------------------------

CREATE FUNCTION trg_app_user_wallet_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.wallet_address IS DISTINCT FROM OLD.wallet_address THEN
    RAISE EXCEPTION 'app_user_wallet_immutable: user % wallet cannot change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER app_user_wallet_immutable
  BEFORE UPDATE ON app_user
  FOR EACH ROW EXECUTE FUNCTION trg_app_user_wallet_immutable();
