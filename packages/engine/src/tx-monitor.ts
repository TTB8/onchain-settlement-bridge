/**
 * @file The transaction monitor: decides, once per pass, what happens next to every `submitted`
 * and `failed` operation of the bound deployment, from FINAL evidence only (ADR 0006, 0007, 0009).
 *
 * A pass (`runOnce`):
 *
 * 1. The bound deployment (chain id + token of the gateway) from the database. Only ITS operations
 *    are examined; non-terminal operations of any other deployment are left alone and alarmed
 *    (obligation 17: evidence for an operation is read from the contract it was sent to).
 * 2. Chain view, head FIRST (obligation 2): `head`, then `confirmedNonce = getNonce(signer, head)`
 *    and `finalNonce = getNonce(signer, max(0, head - depth + 1))`, never the no-block form. Any
 *    read error ends the pass with nothing written (obligation 3). A head that does not move for
 *    `headStallTicks` passes raises `head_stalled` (obligation 10).
 * 3. Per operation, the evidence: EVERY recorded attempt (rejected ones included, obligation 4)
 *    with its receipt and whether the node knows it; every indexed event carrying the reference;
 *    and the canonical hash at each of those events' heights, read from the NODE now, never from
 *    the indexer's own rows (obligations 9, 15). A read error skips the operation this pass.
 * 4. A settling event for the reference that is on the canonical chain is judged by the domain
 *    (`lateConfirmation`): `confirm` moves CONFIRM (or the gated CONFIRM_LATE for a failed
 *    operation, obligation 8) with `confirmedBlock` = the EVENT's block, never the head
 *    (obligation 12); `reference_conflict` fails the operation with that reason and escalates
 *    (obligation 11); `wait` waits.
 * 5. Without one, a `submitted` operation follows the domain's `assessAttempt` verdicts: wait;
 *    a final revert goes through `resolveRevert` and FAILs with its reason (escalating
 *    `duplicate_reference`); `stuck_bump` signs a replacement with the SAME nonce and higher fees;
 *    `dropped` rebroadcasts the same signed bytes (SUBMIT `resubmit`); `give_up` FAILs;
 *    `replaced_or_lost` on every attempt (their nonces are FINALLY used by something else) checks
 *    the contract's reference flag at the final block and only if it is unused, and no event
 *    carries the reference, resubmits with a NEW nonce. Every bump and resubmit inserts its
 *    attempt in the transaction of its SUBMIT move (version-fenced) and broadcasts after commit.
 * 6. A `failed` operation that is not an escalation is reversed only when the domain's
 *    `mayReverse` accepts evidence gathered in this pass (obligations 5-7):
 *    `anAttemptCanStillMine` = OR of `attemptCanStillMine` over every attempt, `chainHasEventForRef`
 *    = ANY indexed event carrying the reference (any kind, any block: more evidence can only block
 *    a reversal), `referenceConsumedOnChain` = `readReferenceUsed('token', ref, finalBlock)`.
 *
 * The monitor never reads the wall clock: `now` comes from the injected clock.
 */

import type { ChainGateway, ContractCall, Fees, Receipt } from '@bridge/chain';
import {
  type ChainAttempt,
  type ChainEvent,
  type Deployment,
  lockRows,
  type Operation,
  type PrismaClient,
} from '@bridge/db';
import {
  type AttemptObservation,
  type AttemptPolicy,
  type AttemptVerdict,
  assessAttempt,
  attemptCanStillMine,
  auditEntryFor,
  bumpFees,
  ESCALATION_REASONS,
  FeeCapExceededError,
  type FailureReason,
  type Finality,
  initialFees,
  lateConfirmation,
  mayReverse,
  type OperationParties,
  resolveRevert,
  type SettlementExpectation,
  type SettlingEventLike,
} from '@bridge/domain';

import type { AlarmKind, AlarmSink } from './alarms';
import {
  commitWithFreshNonce,
  attemptRecordOf,
  broadcastAttempt,
  contractCallFromJson,
  feesOf,
  insertAttempt,
  recordBroadcast,
} from './attempts';
import { VersionConflictError } from './errors';
import { writeAudit } from './ledger-writes';
import { moveOperation, type OperationMove } from './move-operation';
import type { Clock } from './ports';
import { describeError, type SanitizeOptions } from './redact';
import {
  assertSignerBound,
  bindingOf,
  type DeploymentBinding,
  loadBoundDeployment,
  signingExpectationFor,
} from './signer-binding';
import { type RawTransactionInspector, signAndVerify } from './signing';
import { runTransaction, type TransactionOptions } from './transaction';

/** The monitor's patience and limits. */
export interface MonitorPolicy {
  /** Confirmations before anything counts (>= 1). */
  readonly confirmationDepth: number;
  /** Seconds a known, unmined attempt may wait before a fee bump. */
  readonly stuckAfterSeconds: number;
  /** Fee-bump replacements per nonce before giving up. */
  readonly maxBumps: number;
  /** Resubmissions after a drop before giving up. */
  readonly maxResubmits: number;
  /** Fee raise per bump, in basis points (>= 1250). */
  readonly bumpFeeBps: number;
  /** The highest `maxFeePerGas` any attempt may pay. */
  readonly feeCap: bigint;
  /** Headroom on the max fee of a new-nonce resubmission, in basis points. */
  readonly initialFeeMarginBps: number;
  /**
   * Passes with an unchanged head before `head_stalled` is raised, and failed chain-view reads
   * before `node_unreachable` is raised (>= 1).
   */
  readonly headStallTicks: number;
  /**
   * Seconds between two rebroadcasts of a dropped attempt, measured from the last rebroadcast
   * (stamped when it is decided, whatever the node answered). Patience is time, not passes: a fast
   * poll or a flaky node must not burn through `maxResubmits` in seconds.
   */
  readonly dropRetrySeconds: number;
  /**
   * Seconds since an operation's first attempt before a `give_up` verdict raises `nonce_stuck`.
   * A dropped attempt whose nonce is not final is rebroadcast at `dropRetrySeconds` for as long
   * as it stays dropped, before and after this point: `maxResubmits` bounds the COUNTED
   * resubmissions and new-nonce resubmissions, never the rebroadcast of an existing nonce.
   */
  readonly giveUpAfterSeconds: number;
  /** Seconds a failed operation may stay unreversible before `failed_not_reversible`. */
  readonly failedAlarmAfterSeconds: number;
  /**
   * Seconds after which a `ledger_reserved` operation with no attempt and no live outbox row is
   * failed and released (nothing was ever signed for it).
   */
  readonly orphanAfterSeconds: number;
  /** Consecutive passes an operation's evidence read may fail before `operation_skipped`. */
  readonly skipAlarmPasses: number;
}

/** Construction options for `TxMonitor`. */
export interface TxMonitorOptions {
  /** The database. */
  readonly prisma: PrismaClient;
  /** The chain; its own `deployment()` is the binding (review M-2). */
  readonly gateway: ChainGateway;
  /** Decodes signed bytes so bumps and resubmissions are checked before they are stored. */
  readonly inspector: RawTransactionInspector;
  /** The time source. */
  readonly clock: Clock;
  /** Patience and limits. */
  readonly policy: MonitorPolicy;
  /** Where alarms go. */
  readonly alarms: AlarmSink;
  /** Transaction settings. */
  readonly transactions?: TransactionOptions;
  /** Literal secrets (RPC URL, API key, host) removed from every error text written. */
  readonly secrets?: readonly string[];
}

/** What one pass did. */
export interface MonitorSummary {
  /** False when a chain read failed before any operation was examined (nothing was written). */
  readonly ran: boolean;
  /** The head read this pass, or null. */
  readonly head: bigint | null;
  /** Operations examined. */
  readonly examined: number;
  /** Operations skipped because one of their reads failed (unknown: try next pass). */
  readonly skipped: number;
  /** CONFIRM moves. */
  readonly confirmed: number;
  /** CONFIRM_LATE moves. */
  readonly lateConfirmed: number;
  /** FAIL moves. */
  readonly failed: number;
  /** REVERSE moves. */
  readonly reversed: number;
  /** Fee-bump replacements signed. */
  readonly bumped: number;
  /** Resubmissions (same bytes after a drop, or a new nonce). */
  readonly resubmitted: number;
  /** Reserved operations that never signed anything, failed and released this pass. */
  readonly released: number;
}

type Outcome =
  'confirmed' | 'lateConfirmed' | 'failed' | 'reversed' | 'bumped' | 'resubmitted' | 'released';

/** The chain position of one pass. */
interface ChainView {
  readonly head: bigint;
  readonly finalBlock: bigint;
  readonly confirmedNonce: number;
  readonly finalNonce: number;
}

type AttemptWithCall = ChainAttempt & { readonly outbox: { readonly call: unknown } };

/** Everything gathered for one operation in one pass. */
interface Evidence {
  readonly attempts: readonly AttemptWithCall[];
  readonly observations: readonly AttemptObservation[];
  readonly receipts: readonly (Receipt | null)[];
  readonly events: readonly ChainEvent[];
  readonly finality: Finality;
  readonly expectation: SettlementExpectation;
}

const SETTLING_KINDS = new Set(['Minted', 'Burned', 'SettledTransfer']);

/** An indexed event row as the domain's settling event (only for settling kinds). */
function settlingEventOf(e: ChainEvent): SettlingEventLike | null {
  if (e.ref === null || e.amount === null) return null;
  const base = {
    blockNumber: e.blockNumber,
    blockHash: e.blockHash as `0x${string}`,
    ref: e.ref as `0x${string}`,
    amount: BigInt(e.amount.toFixed()),
  };
  if (e.kind === 'Minted' && e.toAddress !== null) {
    return { ...base, kind: 'Minted', to: e.toAddress as `0x${string}` };
  }
  if (e.kind === 'Burned' && e.fromAddress !== null) {
    return { ...base, kind: 'Burned', from: e.fromAddress as `0x${string}` };
  }
  if (e.kind === 'SettledTransfer' && e.fromAddress !== null && e.toAddress !== null) {
    return {
      ...base,
      kind: 'SettledTransfer',
      from: e.fromAddress as `0x${string}`,
      to: e.toAddress as `0x${string}`,
    };
  }
  return null;
}

/** The failure reason a `give_up` verdict records. */
function giveUpReason(why: 'max_bumps' | 'fee_cap' | 'max_resubmits'): FailureReason {
  return why === 'max_resubmits' ? 'dropped' : 'retries_exhausted';
}

/** Watches submitted and failed operations and moves them on final evidence. */
export class TxMonitor {
  private readonly prisma: PrismaClient;
  private readonly gateway: ChainGateway;
  private readonly inspector: RawTransactionInspector;
  private readonly clock: Clock;
  private readonly binding: DeploymentBinding;
  private readonly policy: MonitorPolicy;
  private readonly alarms: AlarmSink;
  private readonly transactions: TransactionOptions;
  private readonly redaction: SanitizeOptions;
  private lastHead: bigint | null = null;
  private stalledPasses = 0;
  private failedReads = 0;
  /**
   * Consecutive failed evidence reads per operation id (review round 2, L-A). In memory: it
   * restarts at zero with the process, which only delays the alarm by `skipAlarmPasses` passes.
   */
  private readonly skips = new Map<string, number>();

  /** @param options Database, gateway, signer, clock, binding, policy and alarm sink. */
  constructor(options: TxMonitorOptions) {
    const p = options.policy;
    if (!Number.isSafeInteger(p.confirmationDepth) || p.confirmationDepth < 1) {
      throw new RangeError('confirmationDepth must be an integer >= 1');
    }
    if (!Number.isSafeInteger(p.headStallTicks) || p.headStallTicks < 1) {
      throw new RangeError('headStallTicks must be an integer >= 1');
    }
    this.prisma = options.prisma;
    this.gateway = options.gateway;
    this.inspector = options.inspector;
    this.clock = options.clock;
    this.binding = bindingOf(options.gateway);
    this.policy = p;
    this.alarms = options.alarms;
    this.transactions = options.transactions ?? {};
    this.redaction = { secrets: [...(options.secrets ?? [])] };
  }

  /** One pass over every submitted and failed operation of the bound deployment. */
  async runOnce(): Promise<MonitorSummary> {
    const counts: Record<Outcome, number> = {
      confirmed: 0,
      lateConfirmed: 0,
      failed: 0,
      reversed: 0,
      bumped: 0,
      resubmitted: 0,
      released: 0,
    };
    const idle = { ran: false, head: null, examined: 0, skipped: 0, ...counts };
    const deployment = await loadBoundDeployment(this.prisma, this.binding);
    if (deployment === null) return idle;

    let view: ChainView;
    try {
      view = await this.readChainView(deployment);
    } catch {
      // Unknown (obligation 3): nothing is decided on a failed read. An unreachable node is a
      // stalled node too: count it (review L-1).
      this.failedReads += 1;
      if (this.failedReads >= this.policy.headStallTicks) {
        this.alarm(
          'node_unreachable',
          `the chain view failed ${this.failedReads} pass(es) in a row`,
        );
      }
      return idle;
    }
    this.failedReads = 0;
    this.trackHead(view.head);

    const foreign = await this.prisma.operation.count({
      where: {
        deploymentId: { not: deployment.id },
        status: { in: ['ledger_reserved', 'submitted', 'failed'] },
      },
    });
    if (foreign > 0) {
      this.alarm(
        'foreign_deployment',
        `${foreign} open operation(s) are bound to another deployment; this engine leaves them alone`,
      );
    }

    const ops = await this.prisma.operation.findMany({
      where: { deploymentId: deployment.id, status: { in: ['submitted', 'failed'] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    let skipped = 0;
    for (const op of ops) {
      let evidence: Evidence;
      try {
        evidence = await this.gather(op, deployment, view);
      } catch (err) {
        skipped += 1;
        const n = (this.skips.get(op.id) ?? 0) + 1;
        this.skips.set(op.id, n);
        if (n >= this.policy.skipAlarmPasses) {
          this.alarm(
            'operation_skipped',
            `evidence read failed ${n} pass(es) in a row: ${describeError(err, this.redaction)}`,
            op.id,
          );
        }
        continue;
      }
      this.skips.delete(op.id);
      try {
        const outcome = await this.decide(op, deployment, view, evidence);
        if (outcome !== null) counts[outcome] += 1;
      } catch (err) {
        // Someone moved the operation first: decide again next pass, on fresh reads.
        if (err instanceof VersionConflictError) continue;
        this.alarm('examine_error', describeError(err, this.redaction), op.id);
      }
    }
    try {
      counts.released += await this.sweepOrphans(deployment, view);
    } catch (err) {
      if (!(err instanceof VersionConflictError)) {
        this.alarm('examine_error', describeError(err, this.redaction));
      }
    }
    return { ran: true, head: view.head, examined: ops.length, skipped, ...counts };
  }

  /**
   * The signer the gateway uses must be the deployment's recorded one before any nonce is read or
   * anything is signed (review M-1): nonces belong to an address, and evidence read for another
   * key would say "nonce free" for every attempt of ours. Then head first, then the two nonce
   * counts at explicit blocks (obligation 2).
   */
  private async readChainView(d: Deployment): Promise<ChainView> {
    await assertSignerBound(this.prisma, this.gateway, d.id, (detail) =>
      this.alarm('signer_mismatch', detail),
    );
    const chainId = await this.gateway.getChainId();
    if (BigInt(chainId) !== this.binding.chainId) {
      this.alarm(
        'chain_mismatch',
        `node reports chain ${chainId}, bound to ${this.binding.chainId}`,
      );
      throw new RangeError('chain mismatch');
    }
    const head = await this.gateway.getHeadBlock();
    const lag = head - BigInt(this.policy.confirmationDepth) + 1n;
    const finalBlock = lag > 0n ? lag : 0n;
    const confirmedNonce = (await this.gateway.getNonce('settlement', head)).confirmed;
    const finalNonce = (await this.gateway.getNonce('settlement', finalBlock)).confirmed;
    return { head, finalBlock, confirmedNonce, finalNonce };
  }

  /** Counts passes with an unchanged head; alarms at the threshold (obligation 10). */
  private trackHead(head: bigint): void {
    if (this.lastHead !== null && head <= this.lastHead) {
      this.stalledPasses += 1;
      if (this.stalledPasses >= this.policy.headStallTicks) {
        this.alarm(
          'head_stalled',
          `head ${head} has not advanced for ${this.stalledPasses} pass(es)`,
        );
      }
    } else {
      this.stalledPasses = 0;
    }
    this.lastHead = head;
  }

  /** Reads every piece of evidence for one operation. Throws on any read error. */
  private async gather(op: Operation, d: Deployment, view: ChainView): Promise<Evidence> {
    const attempts = await this.prisma.chainAttempt.findMany({
      where: { outbox: { operationId: op.id }, deploymentId: d.id },
      include: { outbox: { select: { call: true } } },
      // Oldest first; the last one is the newest: highest nonce, then most bumps. Never by time
      // alone (two attempts can share a timestamp, and then the id order is arbitrary).
      orderBy: [{ nonce: 'asc' }, { bumpsSoFar: 'asc' }, { submittedAt: 'asc' }, { id: 'asc' }],
    });
    const receipts: (Receipt | null)[] = [];
    const observations: AttemptObservation[] = [];
    for (const a of attempts) {
      const receipt = await this.gateway.getReceipt(a.hash as `0x${string}`);
      const known =
        receipt !== null || (await this.gateway.getTransaction(a.hash as `0x${string}`)) !== null;
      receipts.push(receipt);
      observations.push({
        receipt,
        nodeKnowsTx: known,
        confirmedNonce: view.confirmedNonce,
        finalNonce: view.finalNonce,
        head: view.head,
      });
    }
    const events = await this.prisma.chainEvent.findMany({
      where: { deploymentId: d.id, ref: op.ref },
      orderBy: [{ blockNumber: 'asc' }, { logIndex: 'asc' }],
    });
    // Canonical hashes from the node, now (obligations 9 and 15).
    const canonicalBlockHashes = new Map<bigint, `0x${string}`>();
    for (const n of new Set(events.map((e) => e.blockNumber))) {
      const block = await this.gateway.getBlock(n);
      if (block !== null) canonicalBlockHashes.set(n, block.hash);
    }
    return {
      attempts,
      observations,
      receipts,
      events,
      finality: { head: view.head, depth: this.policy.confirmationDepth, canonicalBlockHashes },
      expectation: await this.expectationOf(op),
    };
  }

  /** The operation as the domain compares it with a settling event. */
  private async expectationOf(op: Operation): Promise<SettlementExpectation> {
    const ids = op.counterpartyUserId === null ? [op.userId] : [op.userId, op.counterpartyUserId];
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, walletAddress: true },
    });
    const wallet = (id: string): `0x${string}` => {
      const u = users.find((x) => x.id === id);
      if (u === undefined) throw new RangeError(`no user ${id}`);
      return u.walletAddress as `0x${string}`;
    };
    let parties: OperationParties;
    if (op.type === 'deposit') parties = { type: 'deposit', to: wallet(op.userId) };
    else if (op.type === 'withdrawal') parties = { type: 'withdrawal', from: wallet(op.userId) };
    else {
      parties = {
        type: 'transfer',
        from: wallet(op.userId),
        to: wallet(op.counterpartyUserId ?? op.userId),
      };
    }
    return { ref: op.ref as `0x${string}`, type: op.type, amount: op.amount, parties };
  }

  /** Steps 4 to 6 of the file comment for one operation. */
  private async decide(
    op: Operation,
    d: Deployment,
    view: ChainView,
    ev: Evidence,
  ): Promise<Outcome | null> {
    // Only events whose block hash is the node's canonical hash at that height (obligation 9).
    const canonical = ev.events.filter(
      (e) =>
        SETTLING_KINDS.has(e.kind) &&
        ev.finality.canonicalBlockHashes.get(e.blockNumber) === e.blockHash,
    );
    if (canonical.length > 1) {
      this.alarm(
        'escalation',
        `${canonical.length} canonical settling events carry the reference`,
        op.id,
      );
      return null;
    }
    const [eventRow] = canonical;
    const settling = eventRow === undefined ? null : settlingEventOf(eventRow);
    if (settling !== null && eventRow !== undefined) {
      const judgement = lateConfirmation(ev.expectation, settling, ev.finality);
      if (judgement.verdict === 'wait') return null;
      if (judgement.verdict === 'confirm') {
        const move: OperationMove =
          op.status === 'failed'
            ? { event: 'CONFIRM_LATE', judgement, confirmedBlock: settling.blockNumber }
            : { event: 'CONFIRM', judgement, confirmedBlock: settling.blockNumber };
        await this.move(
          op,
          move,
          `settling event final in block ${settling.blockNumber}`,
          eventRow.txHash,
        );
        return op.status === 'failed' ? 'lateConfirmed' : 'confirmed';
      }
      // reference_conflict: never confirmed, never reversed; a person decides.
      if (op.status === 'submitted') {
        await this.fail(
          op,
          'reference_conflict',
          'a final settling event differs from the operation',
        );
        return 'failed';
      }
      this.alarm('escalation', 'a failed operation has a conflicting settling event', op.id);
      return null;
    }
    if (op.status === 'submitted') return this.decideSubmitted(op, d, view, ev);
    return this.decideFailed(op, view, ev);
  }

  /** Step 5: a submitted operation without a canonical settling event. */
  private async decideSubmitted(
    op: Operation,
    d: Deployment,
    view: ChainView,
    ev: Evidence,
  ): Promise<Outcome | null> {
    const latest = ev.attempts[ev.attempts.length - 1];
    if (latest === undefined) {
      this.alarm('missing_attempts', 'submitted operation has no recorded attempt', op.id);
      return null;
    }
    const now = this.clock.now();
    const policy: AttemptPolicy = {
      confirmations: this.policy.confirmationDepth,
      stuckAfterSeconds: this.policy.stuckAfterSeconds,
      maxBumps: this.policy.maxBumps,
      maxResubmits: this.policy.maxResubmits,
      bumpFeeBps: this.policy.bumpFeeBps,
      feeCap: this.policy.feeCap,
    };
    const verdicts: AttemptVerdict[] = ev.attempts.map((a, i) =>
      assessAttempt(attemptRecordOf(a, op.resubmitsSoFar), this.observation(ev, i), now, policy),
    );
    // Something of ours is mined: settlement is decided from the event, which may lag the receipt.
    if (verdicts.some((v) => v.verdict === 'mined_unconfirmed')) return null;
    if (verdicts.some((v) => v.verdict === 'confirmed')) {
      this.alarm(
        'settled_without_event',
        'a final successful receipt has no indexed event yet',
        op.id,
      );
      return null;
    }
    const reverted = verdicts.find((v) => v.verdict === 'reverted');
    if (reverted !== undefined && reverted.verdict === 'reverted') {
      const resolution = resolveRevert(ev.expectation, reverted.reason, null, ev.finality);
      if (resolution.verdict === 'failed') {
        await this.fail(op, resolution.reason, `reverted in block ${reverted.blockNumber}`);
        return 'failed';
      }
      return null;
    }
    const verdict = verdicts[verdicts.length - 1];
    switch (verdict?.verdict) {
      case 'stuck_bump':
        await this.bump(op, d, latest, verdict.fees);
        return 'bumped';
      case 'dropped':
        return this.dropped(op, d, latest, now);
      case 'give_up':
        return this.givenUp(op, d, ev, view, verdict.why, now);
      case 'replaced_or_lost':
        return this.replacedOrLost(op, d, view, ev, verdicts);
      default:
        return null;
    }
  }

  /**
   * The node forgot the newest attempt (review H-1a). Not more often than every
   * `dropRetrySeconds`. If its fees are below what the node asks now, the same bytes would be
   * dropped again: sign a REPLACEMENT with the same nonce and call at current fees (a `bump`, in
   * one commit with its SUBMIT move). Otherwise rebroadcast the same bytes (`resubmit`).
   */
  private async dropped(
    op: Operation,
    d: Deployment,
    latest: AttemptWithCall,
    now: Date,
    counted = true,
  ): Promise<Outcome | null> {
    const lastSent = latest.lastCheckedAt ?? latest.submittedAt;
    if (now.getTime() - lastSent.getTime() < this.policy.dropRetrySeconds * 1000) return null;
    const estimate = await this.gateway.estimateFees();
    if (latest.maxFeePerGas >= estimate.maxFeePerGas) {
      return (await this.resubmitSame(op, latest, now, counted)) ? 'resubmitted' : null;
    }
    let fees: Fees;
    try {
      const fresh = initialFees(estimate, {
        marginBps: this.policy.initialFeeMarginBps,
        cap: this.policy.feeCap,
      });
      const bumped = bumpFees(feesOf(latest), {
        bumpBps: this.policy.bumpFeeBps,
        cap: this.policy.feeCap,
      });
      fees = {
        maxFeePerGas: max(fresh.maxFeePerGas, bumped.maxFeePerGas),
        maxPriorityFeePerGas: max(fresh.maxPriorityFeePerGas, bumped.maxPriorityFeePerGas),
      };
    } catch (err) {
      if (!(err instanceof FeeCapExceededError)) throw err;
      this.alarm(
        'nonce_stuck',
        `settlement nonce ${latest.nonce}: the fees the node asks exceed the fee cap`,
        op.id,
      );
      return null;
    }
    await this.bump(op, d, latest, fees);
    return 'bumped';
  }

  /**
   * The domain gave up (review H-1b, H-1c). Nothing happens before `giveUpAfterSeconds` since
   * the first attempt. After that, while the attempt's nonce is not final (it is the signer's
   * lowest non-final nonce, or queued behind it), FAILing would release nothing (the operation
   * cannot be reversed while its nonce can still be used) and would only hide the real problem:
   * every later transaction of the signer is stuck behind that nonce. So the operation stays
   * `submitted` and `nonce_stuck` names the signer and the blocking nonce; a person cancels it.
   */
  private async givenUp(
    op: Operation,
    d: Deployment,
    ev: Evidence,
    view: ChainView,
    why: 'max_bumps' | 'fee_cap' | 'max_resubmits',
    now: Date,
  ): Promise<Outcome | null> {
    const first = ev.attempts[0];
    const latest = ev.attempts[ev.attempts.length - 1];
    if (first === undefined || latest === undefined) return null;
    const patient =
      now.getTime() - first.submittedAt.getTime() < this.policy.giveUpAfterSeconds * 1000;
    const notFinal = latest.nonce >= view.finalNonce;
    if (!patient && notFinal) {
      this.alarm(
        'nonce_stuck',
        `settlement signer ${this.gateway.signerAddress('settlement')}: nonce ${view.finalNonce} ` +
          `is the lowest non-final nonce; this operation's nonce ${latest.nonce} gave up (${why})`,
        op.id,
      );
    }
    // Review round 2, N-1: the resubmit COUNTER ran out, but the nonce is still ours and open.
    // Rebroadcasting the same bytes is always safe (same nonce, same reference) and is the only
    // way a dropped transaction gets mined again, so keep doing it on the dropRetrySeconds
    // cadence, uncounted, before and after the give-up point.
    if (why === 'max_resubmits' && notFinal) return this.dropped(op, d, latest, now, false);
    if (patient || notFinal) return null;
    await this.fail(op, giveUpReason(why), `gave up: ${why}`);
    return 'failed';
  }

  /**
   * Every attempt's nonce is FINALLY used by something else. Only when the contract's own flag at
   * the final block and the index both say the reference is unused may a new nonce be signed.
   */
  private async replacedOrLost(
    op: Operation,
    d: Deployment,
    view: ChainView,
    ev: Evidence,
    verdicts: readonly AttemptVerdict[],
  ): Promise<Outcome | null> {
    if (!verdicts.every((v) => v.verdict === 'replaced_or_lost')) return null;
    const used = await this.gateway.readReferenceUsed(
      'token',
      op.ref as `0x${string}`,
      view.finalBlock,
    );
    if (used || ev.events.length > 0) {
      this.alarm(
        'settled_without_event',
        'reference used on chain but no settling event judged yet',
        op.id,
      );
      return null;
    }
    // The NEW-NONCE budget counts new nonces only (review round 2, N-1): rebroadcasts of an
    // existing nonce share the domain's counter but must not use this budget up.
    const newNonces = new Set(ev.attempts.map((a) => a.nonce)).size - 1;
    if (newNonces >= this.policy.maxResubmits) {
      await this.fail(op, 'retries_exhausted', 'nonce taken and resubmissions exhausted');
      return 'failed';
    }
    await this.resubmitNewNonce(op, d, ev);
    return 'resubmitted';
  }

  /** Step 6: reverse a failed operation only on `mayReverse` evidence from this pass. */
  private async decideFailed(
    op: Operation,
    view: ChainView,
    ev: Evidence,
  ): Promise<Outcome | null> {
    const reason = op.failureReason;
    if (reason === null || ESCALATION_REASONS.has(reason)) {
      this.alarmIfLong(op);
      return null;
    }
    const anAttemptCanStillMine = ev.attempts.some((a, i) =>
      attemptCanStillMine(a, this.observation(ev, i), this.policy.confirmationDepth),
    );
    const referenceConsumedOnChain = await this.gateway.readReferenceUsed(
      'token',
      op.ref as `0x${string}`,
      view.finalBlock,
    );
    const evidence = {
      failureReason: reason,
      anAttemptCanStillMine,
      chainHasEventForRef: ev.events.length > 0,
      referenceConsumedOnChain,
    };
    if (!mayReverse(evidence)) {
      if (referenceConsumedOnChain && ev.events.length === 0) {
        // Only a settlement consumes a reference: the money most likely moved (review L-3).
        this.alarm(
          'escalation',
          'the reference is consumed on chain but the index has no event for it',
          op.id,
        );
      }
      this.alarmIfLong(op);
      return null;
    }
    await this.move(op, { event: 'REVERSE', evidence }, `reversed: ${reason}, final evidence`);
    return 'reversed';
  }

  /** `failed_not_reversible` once a failed operation has waited `failedAlarmAfterSeconds`. */
  private alarmIfLong(op: Operation): void {
    const waited = this.clock.now().getTime() - op.updatedAt.getTime();
    if (waited >= this.policy.failedAlarmAfterSeconds * 1000) {
      this.alarm(
        'failed_not_reversible',
        `failed (${String(op.failureReason)}) and not reversible for ${Math.floor(waited / 1000)} s`,
        op.id,
      );
    }
  }

  /**
   * Review M-4: a `ledger_reserved` operation older than `orphanAfterSeconds` with NO attempt and
   * NO live outbox row (its row was dead-lettered before anything was signed) holds funds forever.
   * It is provably unsent: an attempt is only ever inserted in the transaction of SUBMIT `first`,
   * so "still ledger_reserved" means no attempt was committed. Inside ONE transaction, with the
   * operation row locked and every condition re-checked there (a row claimed meanwhile, or an
   * attempt committed meanwhile, stops it), FAIL (`rejected`) then REVERSE with evidence read
   * this pass: no attempt, no indexed event, the reference unused at the final block.
   *
   * The FAIL commits even when `mayReverse` refuses the evidence (an indexed event, or the
   * reference already consumed on chain): the operation is then `failed` and held, visible, and
   * the failed path takes over (the `escalation` alarm for a consumed reference with no event, a
   * late confirmation if its settling event appears, `failed_not_reversible` after a while). Only
   * the reversal is skipped.
   */
  private async sweepOrphans(d: Deployment, view: ChainView): Promise<number> {
    const before = new Date(this.clock.now().getTime() - this.policy.orphanAfterSeconds * 1000);
    const candidates = await this.prisma.operation.findMany({
      where: { deploymentId: d.id, status: 'ledger_reserved', createdAt: { lte: before } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 50,
    });
    let released = 0;
    for (const op of candidates) {
      let used: boolean;
      try {
        used = await this.gateway.readReferenceUsed(
          'token',
          op.ref as `0x${string}`,
          view.finalBlock,
        );
      } catch {
        continue;
      }
      const at = this.clock.now();
      const { value: done } = await runTransaction(
        this.prisma,
        async (tx) => {
          await lockRows(tx, 'operation', [op.id]);
          const fresh = await tx.operation.findUniqueOrThrow({ where: { id: op.id } });
          if (fresh.status !== 'ledger_reserved' || fresh.version !== op.version) return false;
          const live = await tx.outboxMessage.count({
            where: { operationId: op.id, status: { in: ['pending', 'processing'] } },
          });
          const attempts = await tx.chainAttempt.count({
            where: { outbox: { operationId: op.id } },
          });
          const events = await tx.chainEvent.count({ where: { deploymentId: d.id, ref: op.ref } });
          if (live > 0 || attempts > 0) return false;
          const failed = await moveOperation(tx, {
            operationId: op.id,
            from: 'ledger_reserved',
            version: op.version,
            move: { event: 'FAIL', reason: 'rejected' },
            at,
            note: 'reserved but never signed: its outbox row is gone',
          });
          const evidence = {
            failureReason: 'rejected' as const,
            anAttemptCanStillMine: false,
            chainHasEventForRef: events > 0,
            referenceConsumedOnChain: used,
          };
          if (!mayReverse(evidence)) return false;
          await moveOperation(tx, {
            operationId: op.id,
            from: 'failed',
            version: failed.version,
            move: { event: 'REVERSE', evidence },
            at,
            note: 'released: nothing was ever signed for this operation',
          });
          return true;
        },
        this.transactions,
      );
      if (done) {
        released += 1;
        this.alarm(
          'orphan_released',
          'reserved operation never signed: failed and released',
          op.id,
        );
      }
    }
    return released;
  }

  private observation(ev: Evidence, i: number): AttemptObservation {
    const o = ev.observations[i];
    if (o === undefined) throw new RangeError(`no observation for attempt ${i}`);
    return o;
  }

  /** Applies one move in its own transaction, fenced by the version read this pass. */
  private async move(
    op: Operation,
    move: OperationMove,
    note: string,
    txHash?: string,
  ): Promise<void> {
    await runTransaction(
      this.prisma,
      (tx) =>
        moveOperation(tx, {
          operationId: op.id,
          from: op.status,
          version: op.version,
          move,
          at: this.clock.now(),
          note,
          ...(txHash !== undefined ? { txHash: txHash as `0x${string}` } : {}),
        }),
      this.transactions,
    );
  }

  /** FAIL from submitted; an escalation reason also gets an audit row and an alarm. */
  private async fail(op: Operation, reason: FailureReason, note: string): Promise<void> {
    const at = this.clock.now();
    await runTransaction(
      this.prisma,
      async (tx) => {
        await moveOperation(tx, {
          operationId: op.id,
          from: 'submitted',
          version: op.version,
          move: { event: 'FAIL', reason },
          at,
          note,
        });
        if (ESCALATION_REASONS.has(reason)) {
          await writeAudit(
            tx,
            auditEntryFor({
              entity: 'operation',
              entityId: op.id,
              fromState: 'failed',
              toState: 'escalated',
              detail: `${reason}: never reversed automatically; a person decides`,
              at,
            }),
            { failureReason: reason },
          );
        }
      },
      this.transactions,
    );
    if (ESCALATION_REASONS.has(reason)) this.alarm('escalation', reason, op.id);
  }

  /** A fee-bump replacement: same nonce, higher fees, new attempt + SUBMIT `bump` in one commit. */
  private async bump(
    op: Operation,
    d: Deployment,
    latest: AttemptWithCall,
    fees: Fees,
  ): Promise<void> {
    const call = contractCallFromJson(latest.outbox.call);
    const request = { signer: latest.signer, call, nonce: latest.nonce, fees };
    // Same nonce, no allocation: signed and verified before (and outside) the transaction.
    const expected = await signingExpectationFor(this.prisma, d, latest.signer);
    const signed = await signAndVerify(this.gateway, this.inspector, request, expected);
    const { value: attempt } = await runTransaction(
      this.prisma,
      async (tx) => {
        const at = this.clock.now();
        await moveOperation(tx, {
          operationId: op.id,
          from: 'submitted',
          version: op.version,
          move: { event: 'SUBMIT', kind: 'bump' },
          at,
          txHash: signed.hash,
          note: `fee bump of nonce ${latest.nonce}`,
        });
        return insertAttempt(tx, {
          deploymentId: d.id,
          outboxId: latest.outboxId,
          request,
          signed,
          contractAddress: d.tokenAddress,
          bumpsSoFar: latest.bumpsSoFar + 1,
          at,
        });
      },
      this.transactions,
    );
    await this.broadcast(op, attempt);
  }

  /**
   * The node forgot it: rebroadcast the same signed bytes (no new attempt). The rebroadcast time
   * is stamped on the attempt in the SAME transaction as the decision (and, when `counted`, the
   * SUBMIT `resubmit` move), compare-and-set on the previous stamp, BEFORE the broadcast: an
   * unknown answer (a flaky node) must not make the next pass rebroadcast again at once
   * (review round 2, N-1). Returns false when another monitor stamped it first (nothing sent).
   */
  private async resubmitSame(
    op: Operation,
    latest: AttemptWithCall,
    now: Date,
    counted: boolean,
  ): Promise<boolean> {
    const { value: stamped } = await runTransaction(
      this.prisma,
      async (tx) => {
        const r = await tx.chainAttempt.updateMany({
          where: { id: latest.id, lastCheckedAt: latest.lastCheckedAt },
          data: { lastCheckedAt: now },
        });
        if (r.count !== 1) return false;
        if (counted) {
          await moveOperation(tx, {
            operationId: op.id,
            from: 'submitted',
            version: op.version,
            move: { event: 'SUBMIT', kind: 'resubmit', resubmitsSoFar: op.resubmitsSoFar },
            at: now,
            txHash: latest.hash as `0x${string}`,
            note: `rebroadcast of nonce ${latest.nonce} after a drop`,
          });
        }
        return true;
      },
      this.transactions,
    );
    if (!stamped) return false;
    await this.broadcast(op, latest);
    return true;
  }

  /** Every nonce we used is finally taken by something else: sign with a NEW nonce. */
  private async resubmitNewNonce(op: Operation, d: Deployment, ev: Evidence): Promise<void> {
    const latest = ev.attempts[ev.attempts.length - 1];
    if (latest === undefined) return;
    const call: ContractCall = contractCallFromJson(latest.outbox.call);
    const signerAddress = this.gateway.signerAddress('settlement');
    const { pending } = await this.gateway.getNonce('settlement');
    const fees = initialFees(await this.gateway.estimateFees(), {
      marginBps: this.policy.initialFeeMarginBps,
      cap: this.policy.feeCap,
    });
    const attempt = await commitWithFreshNonce({
      prisma: this.prisma,
      gateway: this.gateway,
      inspector: this.inspector,
      expected: await signingExpectationFor(this.prisma, d, 'settlement'),
      allocation: {
        deploymentId: d.id,
        signer: 'settlement',
        signerAddress,
        chainPending: pending,
      },
      build: (nonce) => ({ signer: 'settlement', call, nonce, fees }),
      commit: async (tx, request, signed) => {
        const at = this.clock.now();
        await moveOperation(tx, {
          operationId: op.id,
          from: 'submitted',
          version: op.version,
          move: { event: 'SUBMIT', kind: 'resubmit', resubmitsSoFar: op.resubmitsSoFar },
          at,
          txHash: signed.hash,
          note: `resubmitted with new nonce ${request.nonce}: the old nonce was finally used elsewhere`,
        });
        return insertAttempt(tx, {
          deploymentId: d.id,
          outboxId: latest.outboxId,
          request,
          signed,
          contractAddress: d.tokenAddress,
          bumpsSoFar: 0,
          at,
        });
      },
      transactions: this.transactions,
    });
    await this.broadcast(op, attempt);
  }

  /** Broadcasts after the commit; the next pass judges whatever the answer was. */
  private async broadcast(op: Operation, attempt: ChainAttempt): Promise<void> {
    const result = await broadcastAttempt(this.gateway, attempt);
    await recordBroadcast(
      this.prisma,
      attempt,
      result,
      { entity: 'operation', id: op.id, state: 'submitted' },
      this.clock.now(),
      this.redaction,
    );
  }

  private alarm(kind: AlarmKind, detail: string, operationId?: string): void {
    this.alarms.raise({
      kind,
      detail,
      ...(operationId !== undefined ? { operationId } : {}),
      at: this.clock.now(),
    });
  }
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
