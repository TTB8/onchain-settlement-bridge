-- =================================================================================================
-- SQL guards for the bridge ledger.
--
-- The tables come from the previous migration (generated from schema.prisma). This migration adds
-- what Prisma cannot express: format CHECKs, the double-entry and no-overdraft guarantees, append-
-- only history, the operation state machine and the binding of every row to one deployment.
--
-- Principle: the application (the engine, built on @bridge/domain) is expected to get all of this
-- right. These guards exist for the day it does not. Each one says which bug it stops. Every
-- refusal raises a message that starts with a stable tag (`ledger_unbalanced:`, ...) so tests and
-- operators can tell which guard fired.
--
-- What no guard here can stop: a database superuser (or the table owner) can disable triggers
-- (`ALTER TABLE ... DISABLE TRIGGER`, `session_replication_role = replica`). The application must
-- connect as a role that does not own the tables in production. See packages/db/README.md.
-- =================================================================================================

-- -------------------------------------------------------------------------------------------------
-- 0. Format CHECKs. Stops: mixed-case or truncated addresses and hashes (two spellings of one
--    address would look like two users, and string comparison against chain data would silently
--    miss), negative or zero amounts, the all-zero reference the contracts reject.
-- -------------------------------------------------------------------------------------------------

ALTER TABLE deployment
  ADD CONSTRAINT deployment_chain_id_positive CHECK (chain_id > 0),
  ADD CONSTRAINT deployment_token_address_format CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  ADD CONSTRAINT deployment_registry_address_format CHECK (registry_address ~ '^0x[0-9a-f]{40}$'),
  ADD CONSTRAINT deployment_block_non_negative CHECK (deployment_block >= 0);

-- At most one active deployment per chain: the engine must never be unsure which contracts it
-- writes to.
CREATE UNIQUE INDEX deployment_one_active_per_chain ON deployment (chain_id) WHERE active;

ALTER TABLE app_user
  ADD CONSTRAINT app_user_wallet_address_format CHECK (wallet_address ~ '^0x[0-9a-f]{40}$');

-- fiat_clearing is the system account (no user); every other kind belongs to exactly one user.
-- Stops: a user account without an owner (money nobody can be held to), a second clearing account
-- (the ledger-to-fiat invariant would be split over two rows and checked against only one).
ALTER TABLE account
  ADD CONSTRAINT account_user_matches_kind CHECK ((kind = 'fiat_clearing') = (user_id IS NULL));
CREATE UNIQUE INDEX account_one_fiat_clearing ON account (kind) WHERE kind = 'fiat_clearing';

ALTER TABLE operation
  ADD CONSTRAINT operation_amount_positive CHECK (amount > 0),
  ADD CONSTRAINT operation_ref_format CHECK (ref ~ '^0x[0-9a-f]{64}$'),
  ADD CONSTRAINT operation_ref_not_zero CHECK (ref <> '0x' || repeat('0', 64)),
  ADD CONSTRAINT operation_resubmits_non_negative CHECK (resubmits_so_far >= 0),
  ADD CONSTRAINT operation_version_non_negative CHECK (version >= 0),
  ADD CONSTRAINT operation_idempotency_key_length
    CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 255),
  -- A transfer moves funds between two different users; deposits and withdrawals have one party.
  -- Stops: a self-transfer (the ledger would move funds the chain does not) and a deposit that
  -- silently carries a second party.
  ADD CONSTRAINT operation_counterparty_matches_type CHECK (
    (type = 'transfer' AND counterparty_user_id IS NOT NULL AND counterparty_user_id <> user_id)
    OR (type <> 'transfer' AND counterparty_user_id IS NULL)),
  -- confirmed <=> the block it was confirmed in is known.
  ADD CONSTRAINT operation_confirmed_block_iff_confirmed
    CHECK ((status = 'confirmed') = (confirmed_block IS NOT NULL)),
  ADD CONSTRAINT operation_confirmed_block_non_negative
    CHECK (confirmed_block IS NULL OR confirmed_block >= 0),
  -- A failure has a reason; a reason only exists once something failed (a late confirmation of a
  -- failed operation keeps it as history).
  ADD CONSTRAINT operation_failure_reason_required
    CHECK (status NOT IN ('failed', 'reversed') OR failure_reason IS NOT NULL),
  ADD CONSTRAINT operation_failure_reason_only_after_failure
    CHECK (failure_reason IS NULL OR status IN ('failed', 'reversed', 'confirmed'));

ALTER TABLE posting
  ADD CONSTRAINT posting_amount_positive CHECK (amount > 0);

ALTER TABLE outbox_message
  ADD CONSTRAINT outbox_ref_format CHECK (ref ~ '^0x[0-9a-f]{64}$'),
  ADD CONSTRAINT outbox_ref_not_zero CHECK (ref <> '0x' || repeat('0', 64)),
  ADD CONSTRAINT outbox_call_is_object CHECK (jsonb_typeof(call) = 'object'),
  ADD CONSTRAINT outbox_attempts_non_negative CHECK (attempts_count >= 0),
  -- Exactly one subject, and the signer that subject needs. Stops: a row that sends nothing (or
  -- two things), and a token call routed to the compliance signer or vice versa.
  ADD CONSTRAINT outbox_exactly_one_subject CHECK (
    (operation_id IS NOT NULL AND compliance_change_id IS NULL AND signer = 'settlement')
    OR (operation_id IS NULL AND compliance_change_id IS NOT NULL AND signer = 'compliance')),
  -- A row being processed says who holds it and since when, so a stuck lock can be found.
  ADD CONSTRAINT outbox_processing_is_locked
    CHECK (status <> 'processing' OR (locked_at IS NOT NULL AND locked_by IS NOT NULL));

ALTER TABLE signer_state
  ADD CONSTRAINT signer_state_address_format CHECK (address ~ '^0x[0-9a-f]{40}$');

ALTER TABLE chain_attempt
  ADD CONSTRAINT chain_attempt_hash_format CHECK (hash ~ '^0x[0-9a-f]{64}$'),
  ADD CONSTRAINT chain_attempt_raw_format CHECK (raw_transaction ~ '^0x([0-9a-f]{2})+$'),
  ADD CONSTRAINT chain_attempt_contract_format CHECK (contract_address ~ '^0x[0-9a-f]{40}$'),
  ADD CONSTRAINT chain_attempt_ref_format CHECK (ref ~ '^0x[0-9a-f]{64}$'),
  ADD CONSTRAINT chain_attempt_nonce_non_negative CHECK (nonce >= 0),
  ADD CONSTRAINT chain_attempt_fees_valid
    CHECK (max_priority_fee_per_gas >= 0 AND max_fee_per_gas >= max_priority_fee_per_gas),
  ADD CONSTRAINT chain_attempt_bumps_non_negative CHECK (bumps_so_far >= 0),
  ADD CONSTRAINT chain_attempt_block_hash_format
    CHECK (block_hash IS NULL OR block_hash ~ '^0x[0-9a-f]{64}$'),
  ADD CONSTRAINT chain_attempt_block_seen_together
    CHECK ((block_number IS NULL) = (block_hash IS NULL) AND (block_number IS NULL OR block_number >= 0));

ALTER TABLE compliance_change
  ADD CONSTRAINT compliance_change_ref_format CHECK (ref ~ '^0x[0-9a-f]{64}$'),
  ADD CONSTRAINT compliance_change_ref_not_zero CHECK (ref <> '0x' || repeat('0', 64));

ALTER TABLE indexed_block
  ADD CONSTRAINT indexed_block_number_non_negative CHECK (number >= 0),
  ADD CONSTRAINT indexed_block_hash_format CHECK (hash ~ '^0x[0-9a-f]{64}$'),
  ADD CONSTRAINT indexed_block_parent_hash_format CHECK (parent_hash ~ '^0x[0-9a-f]{64}$');

ALTER TABLE indexer_state
  ADD CONSTRAINT indexer_state_block_non_negative CHECK (last_indexed_block >= 0);

ALTER TABLE chain_event
  ADD CONSTRAINT chain_event_block_hash_format CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  ADD CONSTRAINT chain_event_tx_hash_format CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  ADD CONSTRAINT chain_event_log_index_non_negative CHECK (log_index >= 0),
  ADD CONSTRAINT chain_event_from_format CHECK (from_address IS NULL OR from_address ~ '^0x[0-9a-f]{40}$'),
  ADD CONSTRAINT chain_event_to_format CHECK (to_address IS NULL OR to_address ~ '^0x[0-9a-f]{40}$'),
  ADD CONSTRAINT chain_event_account_format CHECK (account IS NULL OR account ~ '^0x[0-9a-f]{40}$'),
  ADD CONSTRAINT chain_event_ref_format CHECK (ref IS NULL OR ref ~ '^0x[0-9a-f]{64}$'),
  ADD CONSTRAINT chain_event_amount_non_negative CHECK (amount IS NULL OR amount >= 0),
  -- Each kind carries exactly the fields it has on chain. Stops: a half-decoded event (say a Minted
  -- without its reference) that reconciliation would then treat as "no reference".
  ADD CONSTRAINT chain_event_fields_match_kind CHECK (CASE kind
    WHEN 'Minted' THEN to_address IS NOT NULL AND amount IS NOT NULL AND ref IS NOT NULL
      AND from_address IS NULL AND account IS NULL AND flag_value IS NULL
    WHEN 'Burned' THEN from_address IS NOT NULL AND amount IS NOT NULL AND ref IS NOT NULL
      AND to_address IS NULL AND account IS NULL AND flag_value IS NULL
    WHEN 'SettledTransfer' THEN from_address IS NOT NULL AND to_address IS NOT NULL
      AND amount IS NOT NULL AND ref IS NOT NULL AND account IS NULL AND flag_value IS NULL
    WHEN 'Transfer' THEN from_address IS NOT NULL AND to_address IS NOT NULL
      AND amount IS NOT NULL AND account IS NULL AND flag_value IS NULL
    WHEN 'VerificationSet' THEN account IS NOT NULL AND flag_value IS NOT NULL
      AND from_address IS NULL AND to_address IS NULL AND amount IS NULL
    WHEN 'FrozenSet' THEN account IS NOT NULL AND flag_value IS NOT NULL
      AND from_address IS NULL AND to_address IS NULL AND amount IS NULL
  END);

ALTER TABLE reconciliation_run
  ADD CONSTRAINT reconciliation_blocks_non_negative CHECK (at_block >= 0 AND final_block >= 0),
  ADD CONSTRAINT reconciliation_mismatches_is_array CHECK (jsonb_typeof(mismatches) = 'array'),
  ADD CONSTRAINT reconciliation_summary_is_object CHECK (jsonb_typeof(summary) = 'object');

ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_entity_not_empty CHECK (length(entity) > 0 AND length(entity_id) > 0),
  ADD CONSTRAINT audit_log_tx_hash_format CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-f]{64}$'),
  ADD CONSTRAINT audit_log_detail_is_object CHECK (jsonb_typeof(detail) = 'object');

-- -------------------------------------------------------------------------------------------------
-- 1. Every journal entry balances (deferred to COMMIT).
--    Stops: an entry whose debits differ from its credits (money created or destroyed), an entry
--    with a single posting, an entry with no postings at all (inserted, then the postings "forgot").
--    Deferred, so an entry and its postings are written with ordinary INSERTs in one transaction
--    and checked once, at commit. If anyone sets the constraints IMMEDIATE, the check runs after
--    the first posting and refuses: it fails closed, never open.
-- -------------------------------------------------------------------------------------------------

CREATE FUNCTION assert_entry_balanced(p_entry uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  n bigint;
  dr numeric;
  cr numeric;
BEGIN
  SELECT count(*),
         coalesce(sum(amount) FILTER (WHERE side = 'debit'), 0),
         coalesce(sum(amount) FILTER (WHERE side = 'credit'), 0)
    INTO n, dr, cr
    FROM posting WHERE entry_id = p_entry;
  IF n < 2 THEN
    RAISE EXCEPTION 'ledger_unbalanced: journal entry % has % posting(s), needs at least 2', p_entry, n
      USING ERRCODE = 'check_violation';
  END IF;
  IF dr <> cr THEN
    RAISE EXCEPTION 'ledger_unbalanced: journal entry % debits % <> credits %', p_entry, dr, cr
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

CREATE FUNCTION trg_posting_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_entry_balanced(NEW.entry_id);
  RETURN NULL;
END $$;

CREATE FUNCTION trg_journal_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_entry_balanced(NEW.id);
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER posting_entry_balanced
  AFTER INSERT ON posting DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trg_posting_entry_balanced();

CREATE CONSTRAINT TRIGGER journal_entry_balanced
  AFTER INSERT ON journal_entry DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trg_journal_entry_balanced();

-- 1b. A committed entry is sealed: postings may only be added by the transaction that created the
--     entry. Stops: a later transaction appending a balanced Dr/Cr pair to an old entry (each entry
--     would still balance, but history would have changed). `sealed_tx` is always set by the
--     database, whatever the client sends; pg_current_xact_id() is the top-level transaction, so
--     savepoints do not break it.
CREATE FUNCTION trg_journal_entry_seal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.sealed_tx := pg_current_xact_id();
  RETURN NEW;
END $$;

CREATE TRIGGER journal_entry_seal
  BEFORE INSERT ON journal_entry
  FOR EACH ROW EXECUTE FUNCTION trg_journal_entry_seal();

CREATE FUNCTION trg_posting_entry_open() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  sealed xid8;
BEGIN
  SELECT sealed_tx INTO sealed FROM journal_entry WHERE id = NEW.entry_id;
  IF sealed IS DISTINCT FROM pg_current_xact_id() THEN
    RAISE EXCEPTION 'ledger_entry_sealed: journal entry % was committed by another transaction', NEW.entry_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER posting_entry_open
  BEFORE INSERT ON posting
  FOR EACH ROW EXECUTE FUNCTION trg_posting_entry_open();

-- -------------------------------------------------------------------------------------------------
-- 2. No user account may go negative (deferred to COMMIT).
--    Stops: an overdraft, including the classic race where two requests each read the same
--    available balance and both reserve it. User accounts are credit-normal, so only a DEBIT can
--    lower them; for each such posting the guard, at commit:
--      a) UPDATEs the account row (bumps guard_version). That takes the row lock and is the
--         serialisation point: a second transaction spending the same account waits here until the
--         first commits. Under READ COMMITTED it then re-reads with a fresh snapshot and sees the
--         first transaction's postings; under REPEATABLE READ / SERIALIZABLE the UPDATE of a row
--         changed by a concurrent commit raises a serialization failure (40001). Either way the
--         second spend cannot pass on a stale view. (A plain SELECT ... FOR UPDATE would not be
--         enough under REPEATABLE READ: the lock is granted, the snapshot stays stale.)
--      b) recomputes the derived balance from every posting and refuses a negative result.
--    fiat_clearing (the system account) is not checked and never locked by this guard.
--    guard_version is not a balance and must never be read as one.
-- -------------------------------------------------------------------------------------------------

CREATE FUNCTION trg_posting_no_overdraft() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  k account_kind;
  bal numeric;
BEGIN
  SELECT kind INTO k FROM account WHERE id = NEW.account_id;
  IF k = 'fiat_clearing' OR NEW.side = 'credit' THEN
    RETURN NULL;
  END IF;
  UPDATE account SET guard_version = guard_version + 1 WHERE id = NEW.account_id;
  SELECT coalesce(sum(CASE WHEN side = 'credit' THEN amount ELSE -amount END), 0)
    INTO bal FROM posting WHERE account_id = NEW.account_id;
  IF bal < 0 THEN
    RAISE EXCEPTION 'ledger_overdraft: account % (%) would be %', NEW.account_id, k, bal
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER posting_no_overdraft
  AFTER INSERT ON posting DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trg_posting_no_overdraft();

-- Account rows: identity is immutable, rows are never deleted. Stops: re-pointing an account (and
-- its whole history) to another user or kind. Only guard_version may change, and only upwards.
CREATE FUNCTION trg_account_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.guard_version < OLD.guard_version THEN
    RAISE EXCEPTION 'account_immutable: account % identity cannot change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER account_immutable
  BEFORE UPDATE ON account
  FOR EACH ROW EXECUTE FUNCTION trg_account_immutable();

-- -------------------------------------------------------------------------------------------------
-- 3. Append-only history: journal_entry, posting, audit_log (plus no deletes of accounts,
--    operations, compliance changes and chain attempts).
--    Stops: rewriting the ledger or the audit trail after the fact, by a bug (an ORM "upsert" or a
--    cleanup job) or by hand. TRUNCATE skips row triggers, so it gets its own statement trigger.
--    Corrections are new entries (a reverse), never edits.
-- -------------------------------------------------------------------------------------------------

CREATE FUNCTION trg_forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append_only: % on % is not allowed', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER journal_entry_append_only
  BEFORE UPDATE OR DELETE ON journal_entry FOR EACH ROW EXECUTE FUNCTION trg_forbid_change();
CREATE TRIGGER journal_entry_no_truncate
  BEFORE TRUNCATE ON journal_entry FOR EACH STATEMENT EXECUTE FUNCTION trg_forbid_change();

CREATE TRIGGER posting_append_only
  BEFORE UPDATE OR DELETE ON posting FOR EACH ROW EXECUTE FUNCTION trg_forbid_change();
CREATE TRIGGER posting_no_truncate
  BEFORE TRUNCATE ON posting FOR EACH STATEMENT EXECUTE FUNCTION trg_forbid_change();

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION trg_forbid_change();
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION trg_forbid_change();

-- Never deleted: rows other history depends on.
CREATE TRIGGER account_no_delete
  BEFORE DELETE ON account FOR EACH ROW EXECUTE FUNCTION trg_forbid_change();
CREATE TRIGGER account_no_truncate
  BEFORE TRUNCATE ON account FOR EACH STATEMENT EXECUTE FUNCTION trg_forbid_change();
CREATE TRIGGER operation_no_delete
  BEFORE DELETE ON operation FOR EACH ROW EXECUTE FUNCTION trg_forbid_change();
CREATE TRIGGER operation_no_truncate
  BEFORE TRUNCATE ON operation FOR EACH STATEMENT EXECUTE FUNCTION trg_forbid_change();
CREATE TRIGGER compliance_change_no_delete
  BEFORE DELETE ON compliance_change FOR EACH ROW EXECUTE FUNCTION trg_forbid_change();
CREATE TRIGGER compliance_change_no_truncate
  BEFORE TRUNCATE ON compliance_change FOR EACH STATEMENT EXECUTE FUNCTION trg_forbid_change();
-- Every signed transaction is kept until its nonce is final (and after): losing one means losing
-- the only way to tell whether it, or its replacement, was mined.
CREATE TRIGGER chain_attempt_no_delete
  BEFORE DELETE ON chain_attempt FOR EACH ROW EXECUTE FUNCTION trg_forbid_change();
CREATE TRIGGER chain_attempt_no_truncate
  BEFORE TRUNCATE ON chain_attempt FOR EACH STATEMENT EXECUTE FUNCTION trg_forbid_change();

-- -------------------------------------------------------------------------------------------------
-- 4. Operation integrity.
--    Stops: a status jump the state machine forbids (requested -> confirmed would settle money that
--    was never reserved; anything leaving confirmed or reversed would undo a final outcome);
--    rewriting what an operation IS (amount, parties, reference, deployment) after money moved;
--    a lost update (two workers writing from the same read): every UPDATE must carry
--    version = old version + 1, so the second writer of a stale row is refused by the database even
--    if it forgot its `WHERE version = ?`.
--    failed -> confirmed is legal here; its gate (a final, matching on-chain event) is the
--    engine's, via @bridge/domain lateConfirmation(). The database cannot see the chain.
-- -------------------------------------------------------------------------------------------------

CREATE FUNCTION trg_operation_insert() RETURNS trigger
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
  -- New work only goes to the active deployment.
  IF NOT EXISTS (SELECT 1 FROM deployment WHERE id = NEW.deployment_id AND active) THEN
    RAISE EXCEPTION 'deployment_inactive: deployment % is not active', NEW.deployment_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER operation_insert
  BEFORE INSERT ON operation
  FOR EACH ROW EXECUTE FUNCTION trg_operation_insert();

CREATE FUNCTION trg_operation_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.type IS DISTINCT FROM OLD.type
     OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.ref IS DISTINCT FROM OLD.ref
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.counterparty_user_id IS DISTINCT FROM OLD.counterparty_user_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'operation_immutable: operation % identity cannot change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
    RAISE EXCEPTION 'operation_version: operation % is at version %, an update must write %, got %',
      OLD.id, OLD.version, OLD.version + 1, NEW.version
      USING ERRCODE = 'serialization_failure';
  END IF;
  IF NOT ((OLD.status::text || '>' || NEW.status::text) = ANY (ARRAY[
      'requested>ledger_reserved',
      'ledger_reserved>submitted',
      'submitted>submitted',
      'submitted>confirmed',
      'ledger_reserved>failed',
      'submitted>failed',
      'failed>reversed',
      'failed>confirmed'])) THEN
    RAISE EXCEPTION 'operation_transition: % -> % is not a legal transition for operation %',
      OLD.status, NEW.status, OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.resubmits_so_far < OLD.resubmits_so_far THEN
    RAISE EXCEPTION 'operation_immutable: resubmits_so_far cannot go down'
      USING ERRCODE = 'check_violation';
  END IF;
  -- The failure reason is written by the transition into failed, then kept as history.
  IF NEW.failure_reason IS DISTINCT FROM OLD.failure_reason
     AND NOT (OLD.status <> 'failed' AND NEW.status = 'failed') THEN
    RAISE EXCEPTION 'operation_immutable: failure_reason is set only on the transition into failed'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER operation_update
  BEFORE UPDATE ON operation
  FOR EACH ROW EXECUTE FUNCTION trg_operation_update();

-- -------------------------------------------------------------------------------------------------
-- 5. Journal entries consistent with their operation.
--    What this enforces:
--      a) (on insert) the entry kind is legal for the operation's status right now: reserve while
--         requested or ledger_reserved, settle only once confirmed, reverse only once reversed.
--      b) (at commit) the ledger and the status agree: an operation past `requested` has a reserve
--         entry; it has a settle entry iff it is confirmed and a reverse entry iff it is reversed.
--         So "status = confirmed without the settle entry" or "ledger_reserved without the
--         reserve" cannot commit, and since entries are append-only and confirmed/reversed are
--         final, the agreement holds forever. (unique(operation_id, kind) already stops a second
--         entry of the same kind, e.g. a double settle.)
--      c) (on insert) every posting is for exactly the operation's amount and hits only
--         fiat_clearing or an account of the operation's user or counterparty.
--    What it does NOT enforce: WHICH accounts and sides each step uses (the posting table in
--    @bridge/domain ledger.ts, e.g. that a deposit reserve is Dr fiat_clearing / Cr incoming(U)).
--    A wrong-but-balanced pair inside the operation's own accounts would pass here; the balanced,
--    no-overdraft and reconciliation checks are the backstop. Copying the table into SQL would
--    make two sources of truth for it.
-- -------------------------------------------------------------------------------------------------

CREATE FUNCTION trg_journal_entry_kind_legal() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  st operation_status;
BEGIN
  SELECT status INTO st FROM operation WHERE id = NEW.operation_id;
  IF NOT ((NEW.kind = 'reserve' AND st IN ('requested', 'ledger_reserved'))
       OR (NEW.kind = 'settle' AND st = 'confirmed')
       OR (NEW.kind = 'reverse' AND st = 'reversed')) THEN
    RAISE EXCEPTION 'ledger_kind_status: a % entry is not allowed while operation % is %',
      NEW.kind, NEW.operation_id, st
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER journal_entry_kind_legal
  BEFORE INSERT ON journal_entry
  FOR EACH ROW EXECUTE FUNCTION trg_journal_entry_kind_legal();

CREATE FUNCTION assert_operation_ledger_agrees(p_op uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  st operation_status;
  has_reserve boolean;
  has_settle boolean;
  has_reverse boolean;
BEGIN
  SELECT status INTO st FROM operation WHERE id = p_op;
  SELECT bool_or(kind = 'reserve'), bool_or(kind = 'settle'), bool_or(kind = 'reverse')
    INTO has_reserve, has_settle, has_reverse
    FROM journal_entry WHERE operation_id = p_op;
  IF coalesce(has_reserve, false) <> (st <> 'requested')
     OR coalesce(has_settle, false) <> (st = 'confirmed')
     OR coalesce(has_reverse, false) <> (st = 'reversed') THEN
    RAISE EXCEPTION 'ledger_status_mismatch: operation % is % but has reserve=%, settle=%, reverse=%',
      p_op, st, coalesce(has_reserve, false), coalesce(has_settle, false), coalesce(has_reverse, false)
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

CREATE FUNCTION trg_operation_ledger_agrees() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_operation_ledger_agrees(NEW.id);
  RETURN NULL;
END $$;

CREATE FUNCTION trg_journal_entry_ledger_agrees() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_operation_ledger_agrees(NEW.operation_id);
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER operation_ledger_agrees
  AFTER INSERT OR UPDATE ON operation DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trg_operation_ledger_agrees();

CREATE CONSTRAINT TRIGGER journal_entry_ledger_agrees
  AFTER INSERT ON journal_entry DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trg_journal_entry_ledger_agrees();

CREATE FUNCTION trg_posting_matches_operation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  op_user uuid;
  op_counterparty uuid;
  op_amount bigint;
  acc_kind account_kind;
  acc_user uuid;
BEGIN
  SELECT o.user_id, o.counterparty_user_id, o.amount
    INTO op_user, op_counterparty, op_amount
    FROM journal_entry je JOIN operation o ON o.id = je.operation_id
   WHERE je.id = NEW.entry_id;
  SELECT kind, user_id INTO acc_kind, acc_user FROM account WHERE id = NEW.account_id;
  IF acc_kind IS DISTINCT FROM 'fiat_clearing'
     AND acc_user IS DISTINCT FROM op_user
     AND (op_counterparty IS NULL OR acc_user IS DISTINCT FROM op_counterparty) THEN
    RAISE EXCEPTION 'ledger_foreign_account: account % belongs to no party of the operation', NEW.account_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.amount IS DISTINCT FROM op_amount THEN
    RAISE EXCEPTION 'ledger_amount_mismatch: posting of % for an operation of %', NEW.amount, op_amount
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER posting_matches_operation
  BEFORE INSERT ON posting
  FOR EACH ROW EXECUTE FUNCTION trg_posting_matches_operation();

-- -------------------------------------------------------------------------------------------------
-- 6. Chain-side integrity.
-- -------------------------------------------------------------------------------------------------

-- 6a. A row never changes deployment. References are unique per contract, so moving an operation
--     (or its outbox row, attempt, block, event...) to another deployment would let one reference
--     be spent twice or let evidence from one contract confirm an operation on another.
--     Composite foreign keys (outbox -> operation/compliance change on (id, deployment_id, ref);
--     attempt -> outbox on (id, deployment_id, signer, ref); event -> block on
--     (deployment_id, number, hash)) make the binding consistent across tables at insert time;
--     this trigger makes it permanent.
CREATE FUNCTION trg_forbid_deployment_rebind() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deployment_id IS DISTINCT FROM OLD.deployment_id THEN
    RAISE EXCEPTION 'deployment_rebind: % rows cannot move to another deployment', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER operation_deployment_bound BEFORE UPDATE ON operation
  FOR EACH ROW EXECUTE FUNCTION trg_forbid_deployment_rebind();
CREATE TRIGGER outbox_message_deployment_bound BEFORE UPDATE ON outbox_message
  FOR EACH ROW EXECUTE FUNCTION trg_forbid_deployment_rebind();
CREATE TRIGGER chain_attempt_deployment_bound BEFORE UPDATE ON chain_attempt
  FOR EACH ROW EXECUTE FUNCTION trg_forbid_deployment_rebind();
CREATE TRIGGER compliance_change_deployment_bound BEFORE UPDATE ON compliance_change
  FOR EACH ROW EXECUTE FUNCTION trg_forbid_deployment_rebind();
CREATE TRIGGER signer_state_deployment_bound BEFORE UPDATE ON signer_state
  FOR EACH ROW EXECUTE FUNCTION trg_forbid_deployment_rebind();
CREATE TRIGGER indexed_block_deployment_bound BEFORE UPDATE ON indexed_block
  FOR EACH ROW EXECUTE FUNCTION trg_forbid_deployment_rebind();
CREATE TRIGGER indexer_state_deployment_bound BEFORE UPDATE ON indexer_state
  FOR EACH ROW EXECUTE FUNCTION trg_forbid_deployment_rebind();
CREATE TRIGGER chain_event_deployment_bound BEFORE UPDATE ON chain_event
  FOR EACH ROW EXECUTE FUNCTION trg_forbid_deployment_rebind();
CREATE TRIGGER reconciliation_run_deployment_bound BEFORE UPDATE ON reconciliation_run
  FOR EACH ROW EXECUTE FUNCTION trg_forbid_deployment_rebind();

-- 6b. A deployment's identity never changes, and it cannot be switched off while an operation on
--     it is not final (confirmed or reversed) or a compliance change is still in flight
--     (requested or submitted). Stops: "pointing" a deployment row at new contracts (every
--     reference and event bound to it would silently change meaning) and abandoning in-flight
--     money on an old deployment.
CREATE FUNCTION trg_deployment_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.chain_id IS DISTINCT FROM OLD.chain_id
     OR NEW.token_address IS DISTINCT FROM OLD.token_address
     OR NEW.registry_address IS DISTINCT FROM OLD.registry_address
     OR NEW.deployment_block IS DISTINCT FROM OLD.deployment_block
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'deployment_immutable: deployment % identity cannot change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.active AND NOT NEW.active AND (
       EXISTS (SELECT 1 FROM operation WHERE deployment_id = OLD.id
                  AND status NOT IN ('confirmed', 'reversed'))
    OR EXISTS (SELECT 1 FROM compliance_change WHERE deployment_id = OLD.id
                  AND status IN ('requested', 'submitted'))) THEN
    RAISE EXCEPTION 'deployment_in_flight: deployment % still has work that is not final', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER deployment_update
  BEFORE UPDATE ON deployment
  FOR EACH ROW EXECUTE FUNCTION trg_deployment_update();

-- 6c. A signed transaction's identity is immutable. Stops: "fixing" a nonce, hash or fee on an
--     attempt after it was broadcast (the engine would then track a transaction that does not
--     exist, and could reuse a nonce or lose the bytes needed to rebroadcast). Only status,
--     block_number, block_hash, bumps_so_far and last_checked_at may change.
--     On insert, the contract must be the deployment's token (settlement signer) or registry
--     (compliance signer): a transaction aimed anywhere else is not a bridge transaction.
CREATE FUNCTION trg_chain_attempt_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM deployment d WHERE d.id = NEW.deployment_id AND
       ((NEW.signer = 'settlement' AND d.token_address = NEW.contract_address)
     OR (NEW.signer = 'compliance' AND d.registry_address = NEW.contract_address))) THEN
    RAISE EXCEPTION 'chain_attempt_contract: % is not the % contract of deployment %',
      NEW.contract_address, NEW.signer, NEW.deployment_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER chain_attempt_insert
  BEFORE INSERT ON chain_attempt
  FOR EACH ROW EXECUTE FUNCTION trg_chain_attempt_insert();

CREATE FUNCTION trg_chain_attempt_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.outbox_id IS DISTINCT FROM OLD.outbox_id
     OR NEW.signer IS DISTINCT FROM OLD.signer OR NEW.nonce IS DISTINCT FROM OLD.nonce
     OR NEW.hash IS DISTINCT FROM OLD.hash OR NEW.raw_transaction IS DISTINCT FROM OLD.raw_transaction
     OR NEW.max_fee_per_gas IS DISTINCT FROM OLD.max_fee_per_gas
     OR NEW.max_priority_fee_per_gas IS DISTINCT FROM OLD.max_priority_fee_per_gas
     OR NEW.contract_address IS DISTINCT FROM OLD.contract_address
     OR NEW.ref IS DISTINCT FROM OLD.ref OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
    RAISE EXCEPTION 'chain_attempt_immutable: attempt % identity cannot change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER chain_attempt_immutable
  BEFORE UPDATE ON chain_attempt
  FOR EACH ROW EXECUTE FUNCTION trg_chain_attempt_immutable();

-- 6d. An outbox row's payload is immutable. Stops: editing the call (amount, recipient) of a row
--     after an attempt for it may already have been signed, or re-pointing it at another subject.
CREATE FUNCTION trg_outbox_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.signer IS DISTINCT FROM OLD.signer
     OR NEW.call IS DISTINCT FROM OLD.call OR NEW.ref IS DISTINCT FROM OLD.ref
     OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.compliance_change_id IS DISTINCT FROM OLD.compliance_change_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'outbox_immutable: outbox row % payload cannot change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER outbox_message_immutable
  BEFORE UPDATE ON outbox_message
  FOR EACH ROW EXECUTE FUNCTION trg_outbox_immutable();

-- 6e. A signer's address on a deployment never changes. Stops: switching keys under in-flight
--     nonces (the nonce sequence belongs to an address). Rotating a key means a new deployment row.
CREATE FUNCTION trg_signer_state_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.signer IS DISTINCT FROM OLD.signer OR NEW.address IS DISTINCT FROM OLD.address THEN
    RAISE EXCEPTION 'signer_state_immutable: signer % address cannot change', OLD.signer
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER signer_state_immutable
  BEFORE UPDATE ON signer_state
  FOR EACH ROW EXECUTE FUNCTION trg_signer_state_immutable();

-- 6f. Compliance change: identity immutable, legal transitions only, starts as requested, only on
--     an active deployment. Same reasons as for operations: a confirmed change is final, and
--     rewriting which user or flag a change was about would falsify the compliance history.
CREATE FUNCTION trg_compliance_change_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'requested' THEN
    RAISE EXCEPTION 'compliance_transition: a compliance change starts as requested, not %', NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM deployment WHERE id = NEW.deployment_id AND active) THEN
    RAISE EXCEPTION 'deployment_inactive: deployment % is not active', NEW.deployment_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER compliance_change_insert
  BEFORE INSERT ON compliance_change
  FOR EACH ROW EXECUTE FUNCTION trg_compliance_change_insert();

CREATE FUNCTION trg_compliance_change_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.action IS DISTINCT FROM OLD.action OR NEW.ref IS DISTINCT FROM OLD.ref
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'compliance_immutable: compliance change % identity cannot change', OLD.id
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

CREATE TRIGGER compliance_change_update
  BEFORE UPDATE ON compliance_change
  FOR EACH ROW EXECUTE FUNCTION trg_compliance_change_update();

-- -------------------------------------------------------------------------------------------------
-- 7. Derived balances. A balance is never stored: it is the sum of the account's postings, in the
--    account's normal direction (user accounts are credit-normal: credits minus debits;
--    fiat_clearing is debit-normal: debits minus credits). Accounts with no postings show 0.
-- -------------------------------------------------------------------------------------------------

CREATE VIEW account_balance AS
SELECT a.id AS account_id,
       a.kind,
       a.user_id,
       coalesce(sum(CASE WHEN (a.kind = 'fiat_clearing') = (p.side = 'debit') THEN p.amount
                         ELSE -p.amount END), 0)::bigint AS balance
  FROM account a
  LEFT JOIN posting p ON p.account_id = a.id
 GROUP BY a.id, a.kind, a.user_id;
