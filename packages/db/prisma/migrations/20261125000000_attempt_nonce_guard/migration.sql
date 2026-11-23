-- =================================================================================================
-- Backstop for the engine's nonce allocation (review round 2, L-B). Hand-written; additive only.
--
-- The engine hands out a nonce while holding `signer_state FOR UPDATE` and skips every nonce a
-- recorded attempt already holds. That is only correct at READ COMMITTED: under REPEATABLE READ
-- (or SERIALIZABLE) the second transaction's read of the held nonces uses a snapshot taken before
-- the first one committed, so it misses the winner's attempt and two DIFFERENT operations can
-- record the same (deployment, signer, nonce). On chain only one of them can ever be mined; the
-- other operation would look "replaced", and its funds could be released while the transaction
-- that actually used the nonce was its competitor's. A nonce shared between subjects is never
-- legitimate. The same subject (one outbox row) re-using its nonce is: a fee bump, a rebroadcast.
--
-- The guard, AFTER INSERT on chain_attempt (after the row's own CHECKs and foreign keys, so a
-- malformed row still fails with its specific error first; the effect is the same as BEFORE: the
-- statement fails and nothing is stored):
--   1. Only at READ COMMITTED. A snapshot older than the statement cannot see a concurrent
--      winner, so no check written in SQL could be trusted there: refuse (chain_attempt_isolation).
--   2. A transaction-scoped advisory lock on (deployment, signer, nonce) serialises two inserts of
--      the same nonce. The second waits until the first commits; its next statement (a fresh
--      snapshot at READ COMMITTED) then sees the winner.
--   3. Refuse a (deployment, signer, nonce) already held by an attempt of another outbox row
--      (chain_attempt_nonce_taken).
-- =================================================================================================

CREATE FUNCTION trg_chain_attempt_nonce() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'chain_attempt_isolation: attempts are recorded at READ COMMITTED only, not %',
      current_setting('transaction_isolation')
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.deployment_id::text || ':' || NEW.signer::text || ':' || NEW.nonce::text, 0));
  IF EXISTS (SELECT 1 FROM chain_attempt
              WHERE deployment_id = NEW.deployment_id AND signer = NEW.signer
                AND nonce = NEW.nonce AND outbox_id <> NEW.outbox_id AND id <> NEW.id) THEN
    RAISE EXCEPTION 'chain_attempt_nonce_taken: % nonce % of deployment % is held by another subject',
      NEW.signer, NEW.nonce, NEW.deployment_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER chain_attempt_nonce
  AFTER INSERT ON chain_attempt
  FOR EACH ROW EXECUTE FUNCTION trg_chain_attempt_nonce();
