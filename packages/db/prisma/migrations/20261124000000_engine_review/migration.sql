-- =================================================================================================
-- Fixes from the independent review of the engine (piece A). Hand-written; additive only.
--
-- 1. New work holds a SHARE lock on its deployment row until it commits (review M-1).
-- 2. outbox_message records why its last attempt did not finish (review L-1, L-2).
-- 3. Idempotency keys are scoped to the user (review I-1).
-- =================================================================================================

-- -------------------------------------------------------------------------------------------------
-- 1. Stops: a deactivation racing a request, with both committing. The insert guards checked
--    `active` with a plain SELECT, and the foreign key to deployment only takes FOR KEY SHARE, which
--    does not conflict with an UPDATE of the non-key `active` column. So a request could read
--    "active", a deactivation could find no in-flight work (the request had not committed) and
--    commit, and then the request committed an operation bound to a retired deployment: exactly
--    the switch-with-work-in-flight that ADR 0011 forbids.
--    With FOR SHARE, the two serialise on the deployment row:
--      - insert first: the deactivation's UPDATE waits for the insert to commit, then its own
--        guard sees the non-final operation and refuses (deployment_in_flight);
--      - deactivation first: the insert waits, then re-checks the row as committed (active is now
--        false), finds nothing and refuses (deployment_inactive).
--    Every writer goes through these triggers, so this holds even for a writer that forgets to
--    lock the row itself (the engine also locks it, to refuse early with a typed error).
-- -------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_operation_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status NOT IN ('requested', 'ledger_reserved') THEN
    RAISE EXCEPTION 'operation_transition: an operation starts as requested or ledger_reserved, not %', NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <> 0 OR NEW.resubmits_so_far <> 0 THEN
    RAISE EXCEPTION 'operation_version: a new operation starts at version 0 with no resubmits'
      USING ERRCODE = 'check_violation';
  END IF;
  -- New work only goes to the active deployment, and keeps it active until this commits.
  PERFORM 1 FROM deployment WHERE id = NEW.deployment_id AND active FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deployment_inactive: deployment % is not active', NEW.deployment_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION trg_compliance_change_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'requested' THEN
    RAISE EXCEPTION 'compliance_transition: a compliance change starts as requested, not %', NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM 1 FROM deployment WHERE id = NEW.deployment_id AND active FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deployment_inactive: deployment % is not active', NEW.deployment_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- -------------------------------------------------------------------------------------------------
-- 2. Stops: an outbox row that died or keeps retrying with no record of why. The dispatcher writes
--    a redacted, truncated message (never an RPC URL, which can carry an API key). Bounded so a
--    huge error body cannot bloat the table; both columns are set together.
-- -------------------------------------------------------------------------------------------------

ALTER TABLE "outbox_message"
  ADD COLUMN "last_error" TEXT,
  ADD COLUMN "last_error_at" TIMESTAMPTZ(6);

ALTER TABLE outbox_message
  ADD CONSTRAINT outbox_last_error_length
    CHECK (last_error IS NULL OR length(last_error) BETWEEN 1 AND 1000),
  ADD CONSTRAINT outbox_last_error_at_with_error
    CHECK ((last_error IS NULL) = (last_error_at IS NULL));

-- -------------------------------------------------------------------------------------------------
-- 3. Stops: one user's idempotency key colliding with another's. A global unique key let a user
--    probe for keys other users had chosen (the conflict revealed that the key existed) and made
--    two users' independent requests interfere. The key now names a request of ONE user.
-- -------------------------------------------------------------------------------------------------

DROP INDEX "operation_idempotency_key_key";
CREATE UNIQUE INDEX "operation_user_id_idempotency_key_key" ON "operation"("user_id", "idempotency_key");
