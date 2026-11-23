/**
 * @file Alarms: conditions a person must look at, raised by the monitors, the indexer and the
 * reconciler.
 *
 * Why a port and not a log line: an alarm is a page for an operator (a stalled node, an escalated
 * operation, a reorg deeper than the window). The production wiring sends them to monitoring; the
 * tests read them from `AlarmLog` and assert that the right one was raised. Escalations of an
 * operation are ALSO written to the audit trail, in the transaction that fails the operation.
 */

/** What kind of condition was seen. */
export type AlarmKind =
  /** The chain head has not advanced for `headStallTicks` passes (obligation 10). */
  | 'head_stalled'
  /** An operation failed with an escalation reason; a person decides (obligation 11). */
  | 'escalation'
  /** Non-terminal operations exist on a deployment this engine does not talk to. */
  | 'foreign_deployment'
  /** The node reports another chain id than the bound deployment's. */
  | 'chain_mismatch'
  /** A reorg deeper than the indexer's window: the indexer stopped (obligation 14). */
  | 'reorg_beyond_window'
  /** The reference is used on chain (or mined successfully) but the index shows no event. */
  | 'settled_without_event'
  /** A `submitted` operation has no recorded attempt (should be impossible). */
  | 'missing_attempts'
  /** Examining one operation failed for a reason that is not a chain read. */
  | 'examine_error'
  /**
   * The signer's lowest non-final nonce belongs to an attempt the engine gave up on: every later
   * transaction of that signer queues behind it. Needs a person (a cancel transaction).
   */
  | 'nonce_stuck'
  /** A failed operation still cannot be reversed after the configured time. */
  | 'failed_not_reversible'
  /** The gateway signs with another address than the deployment's `signer_state` row. */
  | 'signer_mismatch'
  /** Chain reads kept failing for the configured number of passes (unreachable node). */
  | 'node_unreachable'
  /** The indexer could not finish a pass for the configured number of passes. */
  | 'indexer_stalled'
  /** A reserved operation that never signed anything was failed and released. */
  | 'orphan_released'
  /** One component of `tick()` threw; the others still ran. */
  | 'component_failed'
  /** The gateway's deployment is not the database's active deployment: the engine refuses to run. */
  | 'deployment_mismatch'
  /** An operation's evidence read failed for the configured number of passes in a row. */
  | 'operation_skipped'
  /**
   * A compliance change met a registry event carrying its reference that writes something else
   * (another account, flag or value: a front-run or a compromised key), or its reference was
   * consumed with no matching event. Never confirmed automatically; a person decides.
   */
  | 'compliance_escalation'
  /** A reconciliation run could not compare (a read failed, the index is behind, bad input). */
  | 'reconciliation_unknown'
  /** Reconciliation: the ledger settled an operation the chain shows no event for. */
  | 'reconciliation_missing_onchain'
  /** Reconciliation: a settling event moved another amount than the ledger says. */
  | 'reconciliation_amount_mismatch'
  /** Reconciliation: a settling event moved between other addresses than the ledger says. */
  | 'reconciliation_address_mismatch'
  /** Reconciliation: the settling event is in another block than the ledger recorded. */
  | 'reconciliation_confirmed_block_mismatch'
  /** Reconciliation: a reference event the ledger cannot explain (or from a stale block). */
  | 'reconciliation_unexpected_onchain_event'
  /** Reconciliation: tokens moved with no bridge reference event (a rogue transfer). */
  | 'reconciliation_unexplained_transfer'
  /** Reconciliation: an address holds another balance on chain than the ledger implies. */
  | 'reconciliation_balance_mismatch'
  /** Reconciliation: the total supply differs from the ledger's. */
  | 'reconciliation_supply_mismatch'
  /** Reconciliation: a registry event the bridge did not make, or that writes something else. */
  | 'reconciliation_compliance_event_mismatch'
  /** Reconciliation: registry flags differ from what the bridge believes. */
  | 'reconciliation_compliance_mismatch';

/** One raised alarm. */
export interface EngineAlarm {
  /** What was seen. */
  readonly kind: AlarmKind;
  /** A short, redacted explanation. */
  readonly detail: string;
  /** The operation concerned, when there is one. */
  readonly operationId?: string;
  /** The compliance change concerned, when there is one. */
  readonly complianceChangeId?: string;
  /** The reconciliation run concerned, when there is one. */
  readonly reconciliationRunId?: string;
  /** When (from the injected clock). */
  readonly at: Date;
}

/** Where alarms go. */
export interface AlarmSink {
  /**
   * Records one alarm. Must not throw.
   *
   * @param alarm The alarm.
   */
  raise(alarm: EngineAlarm): void;
}

/** An in-memory `AlarmSink`, for tests and as the default. Keeps the newest `limit` alarms. */
export class AlarmLog implements AlarmSink {
  private readonly items: EngineAlarm[] = [];

  /** @param limit How many alarms to keep (oldest dropped first). */
  constructor(private readonly limit = 1000) {}

  /** @inheritdoc */
  raise(alarm: EngineAlarm): void {
    this.items.push(alarm);
    if (this.items.length > this.limit) this.items.shift();
  }

  /** The alarms kept, oldest first. */
  get all(): readonly EngineAlarm[] {
    return this.items;
  }

  /** The kept alarms of one kind. */
  ofKind(kind: AlarmKind): EngineAlarm[] {
    return this.items.filter((a) => a.kind === kind);
  }
}
