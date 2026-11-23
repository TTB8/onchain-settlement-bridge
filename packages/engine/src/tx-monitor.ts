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
import type { ChainAttempt, ChainEvent, Deployment, Operation, PrismaClient } from '@bridge/db';
import {
  type AttemptObservation,
  type AttemptPolicy,
  type AttemptVerdict,
  assessAttempt,
  attemptCanStillMine,
  auditEntryFor,
  ESCALATION_REASONS,
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
  allocateNonce,
  attemptRecordOf,
  broadcastAttempt,
  contractCallFromJson,
  insertAttempt,
  recordBroadcast,
} from './attempts';
import { VersionConflictError } from './errors';
import { writeAudit } from './ledger-writes';
import { moveOperation, type OperationMove } from './move-operation';
import type { Clock } from './ports';
import { describeError } from './redact';
import type { DeploymentBinding } from './settlement-submitter';
import type { TransactionSigner } from './signing';
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
  /** Passes with an unchanged head before `head_stalled` is raised (>= 1). */
  readonly headStallTicks: number;
}

/** Construction options for `TxMonitor`. */
export interface TxMonitorOptions {
  /** The database. */
  readonly prisma: PrismaClient;
  /** The chain. */
  readonly gateway: ChainGateway;
  /** Signs bumps and resubmissions before they are recorded. */
  readonly signer: TransactionSigner;
  /** The time source. */
  readonly clock: Clock;
  /** The deployment the gateway talks to. */
  readonly binding: DeploymentBinding;
  /** Patience and limits. */
  readonly policy: MonitorPolicy;
  /** Where alarms go. */
  readonly alarms: AlarmSink;
  /** Transaction settings. */
  readonly transactions?: TransactionOptions;
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
}

type Outcome = 'confirmed' | 'lateConfirmed' | 'failed' | 'reversed' | 'bumped' | 'resubmitted';

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
  private readonly signer: TransactionSigner;
  private readonly clock: Clock;
  private readonly binding: DeploymentBinding;
  private readonly policy: MonitorPolicy;
  private readonly alarms: AlarmSink;
  private readonly transactions: TransactionOptions;
  private lastHead: bigint | null = null;
  private stalledPasses = 0;

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
    this.signer = options.signer;
    this.clock = options.clock;
    this.binding = options.binding;
    this.policy = p;
    this.alarms = options.alarms;
    this.transactions = options.transactions ?? {};
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
    };
    const idle = { ran: false, head: null, examined: 0, skipped: 0, ...counts };
    const deployment = await this.prisma.deployment.findUnique({
      where: {
        chainId_tokenAddress: {
          chainId: this.binding.chainId,
          tokenAddress: this.binding.tokenAddress,
        },
      },
    });
    if (deployment === null) return idle;

    let view: ChainView;
    try {
      view = await this.readChainView();
    } catch {
      // Unknown (obligation 3): nothing is decided on a failed read.
      return idle;
    }
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
      } catch {
        skipped += 1;
        continue;
      }
      try {
        const outcome = await this.decide(op, deployment, view, evidence);
        if (outcome !== null) counts[outcome] += 1;
      } catch (err) {
        // Someone moved the operation first: decide again next pass, on fresh reads.
        if (err instanceof VersionConflictError) continue;
        this.alarm('examine_error', describeError(err), op.id);
      }
    }
    return { ran: true, head: view.head, examined: ops.length, skipped, ...counts };
  }

  /** Head first, then the two nonce counts at explicit blocks (obligation 2). */
  private async readChainView(): Promise<ChainView> {
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
        await this.resubmitSame(op, latest);
        return 'resubmitted';
      case 'give_up':
        await this.fail(op, giveUpReason(verdict.why), `gave up: ${verdict.why}`);
        return 'failed';
      case 'replaced_or_lost':
        return this.replacedOrLost(op, d, view, ev, verdicts);
      default:
        return null;
    }
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
    if (op.resubmitsSoFar >= this.policy.maxResubmits) {
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
    if (reason === null || ESCALATION_REASONS.has(reason)) return null;
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
    if (!mayReverse(evidence)) return null;
    await this.move(op, { event: 'REVERSE', evidence }, `reversed: ${reason}, final evidence`);
    return 'reversed';
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
    const { value: attempt } = await runTransaction(
      this.prisma,
      async (tx) => {
        const at = this.clock.now();
        const signed = await this.signer.sign(request);
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
    await this.broadcast(op, attempt, call);
  }

  /** The node forgot it: rebroadcast the same signed bytes (SUBMIT `resubmit`, no new attempt). */
  private async resubmitSame(op: Operation, latest: AttemptWithCall): Promise<void> {
    const call = contractCallFromJson(latest.outbox.call);
    await this.move(
      op,
      { event: 'SUBMIT', kind: 'resubmit', resubmitsSoFar: op.resubmitsSoFar },
      `rebroadcast of nonce ${latest.nonce} after a drop`,
      latest.hash,
    );
    await this.broadcast(op, latest, call);
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
    const { value: attempt } = await runTransaction(
      this.prisma,
      async (tx) => {
        const at = this.clock.now();
        const nonce = await allocateNonce(tx, {
          deploymentId: d.id,
          signer: 'settlement',
          signerAddress,
          chainPending: pending,
        });
        const request = { signer: 'settlement' as const, call, nonce, fees };
        const signed = await this.signer.sign(request);
        await moveOperation(tx, {
          operationId: op.id,
          from: 'submitted',
          version: op.version,
          move: { event: 'SUBMIT', kind: 'resubmit', resubmitsSoFar: op.resubmitsSoFar },
          at,
          txHash: signed.hash,
          note: `resubmitted with new nonce ${nonce}: the old nonce was finally used elsewhere`,
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
      this.transactions,
    );
    await this.broadcast(op, attempt, call);
  }

  /** Broadcasts after the commit; the next pass judges whatever the answer was. */
  private async broadcast(op: Operation, attempt: ChainAttempt, call: ContractCall): Promise<void> {
    const result = await broadcastAttempt(this.signer, attempt, call);
    await recordBroadcast(
      this.prisma,
      attempt,
      result,
      { entity: 'operation', id: op.id, state: 'submitted' },
      this.clock.now(),
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
