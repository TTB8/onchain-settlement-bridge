/**
 * @file The compliance monitor: decides, once per pass, what happens next to every `submitted`
 * and `failed` compliance change of the bound deployment, from FINAL evidence only. A separate
 * class from `TxMonitor` (not an extension) because its subject, its signer and its terminal
 * states differ, while every piece of machinery is shared: the chain view rules, the attempt
 * verdicts (`assessAttempt`), the nonce and attempt helpers of `attempts.ts`, `signAndVerify`, the
 * signer binding and the alarm sink.
 *
 * A pass (`runOnce`):
 *
 * 1. The bound deployment from the gateway's own `deployment()` (token AND registry). The
 *    gateway's COMPLIANCE key must be the deployment's recorded compliance signer before any nonce
 *    is read (else `signer_mismatch` and nothing is decided). Then head FIRST, and the compliance
 *    signer's nonce at the head and at the final block (obligation 2). Any read error ends the
 *    pass with nothing written (obligation 3).
 * 2. Per change: EVERY recorded attempt (rejected ones too, obligation 4) with its receipt and
 *    whether the node knows it, every indexed event carrying the change's reference, and the
 *    canonical hash of each event's block read from the NODE now (obligations 9, 15).
 * 3. A registry event on a canonical block carrying the reference is judged by the domain
 *    (`judgeComplianceEvent`): `confirm` (final, canonical, and exactly this change: reference,
 *    account, flag, value) moves CONFIRM (or the gated CONFIRM_LATE for a failed change,
 *    obligation 8) with `confirmedBlock` = the event's block (obligation 12); `conflict` (the
 *    reference was used to write something else: a front-run or a compromised key) FAILs a
 *    submitted change with `reference_conflict` and escalates; `wait` waits. Nothing else ever
 *    confirms a change: not a successful receipt, not the registry's flag.
 * 4. Without one, a submitted change follows the attempt verdicts exactly as an operation does:
 *    wait while mined but not final; a final revert FAILs (`duplicate_reference`, escalated, when
 *    the registry says the reference is already used); `stuck_bump` signs a same-nonce replacement;
 *    `dropped` rebroadcasts the same bytes (or a same-nonce replacement at current fees);
 *    `give_up` FAILs only once the nonce is final, else `nonce_stuck`; `replaced_or_lost` on every
 *    attempt checks the registry's reference flag at the final block before a new nonce.
 * 5. There is no reversal: a compliance change moves no funds, and the domain table has no edge
 *    out of `confirmed`. A failed change is only ever left alone, or late-confirmed on evidence.
 * 6. A `requested` change older than `orphanAfterSeconds` with no attempt and no live outbox row
 *    (its row died before anything was signed) is FAILed (`rejected`), so the deployment can be
 *    retired and the operator sees it.
 * 7. Review piece C:
 *    - a CONFIRM (or CONFIRM_LATE) whose event block is out of DECISION order with another
 *      confirmed change for the same account and flag (an older decision landing after a newer
 *      one, or the reverse) raises `compliance_out_of_order`: the registry now holds the older
 *      decision's value, which the reconciler reports as `compliance_mismatch` (M-1);
 *    - a change still `requested` / `submitted` after `pendingAlarmAfterSeconds` raises
 *      `compliance_pending`, freezes first (a freeze that has not landed is the one that lets a
 *      sanctioned account keep moving funds; page those first) (L-2);
 *    - a FAILED change is re-examined only within `failedLookbackSeconds` of its last update, or
 *      while an indexed event carries its reference (the only thing that can late-confirm it or
 *      show a conflict); anything else is history (L-3).
 */

import type { ChainGateway, ContractCall, Fees, Receipt } from '@bridge/chain';
import {
  type ChainAttempt,
  type ChainEvent,
  type ComplianceChange,
  type Deployment,
  lockRows,
  type PrismaClient,
} from '@bridge/db';
import {
  type AttemptObservation,
  type AttemptPolicy,
  type AttemptVerdict,
  assessAttempt,
  auditEntryFor,
  bumpFees,
  type ComplianceChangeContent,
  type ComplianceEventLike,
  FeeCapExceededError,
  type FailureReason,
  type Finality,
  flagChangeFor,
  initialFees,
  judgeComplianceEvent,
} from '@bridge/domain';

import type { AlarmKind, AlarmSink } from './alarms';
import {
  attemptRecordOf,
  broadcastAttempt,
  commitWithFreshNonce,
  contractCallFromJson,
  feesOf,
  insertAttempt,
  recordBroadcast,
} from './attempts';
import { type ComplianceMove, moveComplianceChange } from './compliance-move';
import { ComplianceVersionConflictError } from './errors';
import { writeAudit } from './ledger-writes';
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
import type { MonitorPolicy } from './tx-monitor';

/** Construction options for `ComplianceMonitor`. */
export interface ComplianceMonitorOptions {
  /** The database. */
  readonly prisma: PrismaClient;
  /** The chain; its own `deployment()` is the binding. */
  readonly gateway: ChainGateway;
  /** Decodes signed bytes so bumps and resubmissions are checked before they are stored. */
  readonly inspector: RawTransactionInspector;
  /** The time source. */
  readonly clock: Clock;
  /** The same patience and limits as the transaction monitor. */
  readonly policy: MonitorPolicy;
  /** Where alarms go. */
  readonly alarms: AlarmSink;
  /** Transaction settings. */
  readonly transactions?: TransactionOptions;
  /** Literal secrets removed from every error text written. */
  readonly secrets?: readonly string[];
  /**
   * Seconds a change may stay requested / submitted before `compliance_pending`. Default
   * `DEFAULT_COMPLIANCE_PENDING_ALARM_SECONDS`.
   */
  readonly pendingAlarmAfterSeconds?: number;
  /**
   * Seconds after its last update during which a FAILED change is re-examined without a new
   * event. Default `DEFAULT_COMPLIANCE_FAILED_LOOKBACK_SECONDS`.
   */
  readonly failedLookbackSeconds?: number;
}

/**
 * Default seconds before `compliance_pending`: 900 (15 min). WHY: a registry call is one small
 * transaction; a quarter of an hour outlasts fee spikes and a node restart, and a freeze that has
 * not landed by then is a compliance incident that needs a person now, not at the next audit.
 */
export const DEFAULT_COMPLIANCE_PENDING_ALARM_SECONDS = 900;

/**
 * Default look-back for failed changes: 7 days. WHY: a failed attempt can only land while its
 * nonce is not final, which takes minutes; a week covers any manual resubmission or operator
 * investigation, and any later event carrying the reference still brings the change back.
 */
export const DEFAULT_COMPLIANCE_FAILED_LOOKBACK_SECONDS = 7 * 24 * 3600;

/** What one pass did. */
export interface ComplianceMonitorSummary {
  /** False when a chain read failed before any change was examined (nothing was written). */
  readonly ran: boolean;
  /** The head read this pass, or null. */
  readonly head: bigint | null;
  /** Changes examined. */
  readonly examined: number;
  /** Changes skipped because one of their reads failed. */
  readonly skipped: number;
  /** CONFIRM moves. */
  readonly confirmed: number;
  /** CONFIRM_LATE moves. */
  readonly lateConfirmed: number;
  /** FAIL moves. */
  readonly failed: number;
  /** Fee-bump replacements signed. */
  readonly bumped: number;
  /** Resubmissions (same bytes after a drop, or a new nonce). */
  readonly resubmitted: number;
}

type Outcome = 'confirmed' | 'lateConfirmed' | 'failed' | 'bumped' | 'resubmitted';

interface ChainView {
  readonly head: bigint;
  readonly finalBlock: bigint;
  readonly confirmedNonce: number;
  readonly finalNonce: number;
}

type AttemptWithCall = ChainAttempt & { readonly outbox: { readonly call: unknown } };
type ChangeWithWallet = ComplianceChange & { readonly user: { readonly walletAddress: string } };

interface Evidence {
  readonly attempts: readonly AttemptWithCall[];
  readonly observations: readonly AttemptObservation[];
  readonly receipts: readonly (Receipt | null)[];
  readonly events: readonly ChainEvent[];
  readonly finality: Finality;
  readonly content: ComplianceChangeContent;
}

/** The empty summary of a pass that did not run. */
export const EMPTY_COMPLIANCE_SUMMARY: ComplianceMonitorSummary = Object.freeze({
  ran: false,
  head: null,
  examined: 0,
  skipped: 0,
  confirmed: 0,
  lateConfirmed: 0,
  failed: 0,
  bumped: 0,
  resubmitted: 0,
});

/**
 * An indexed registry event row as the domain's `ComplianceEventLike`, or null for any other kind
 * (or a row missing a field, which the database CHECK makes impossible).
 *
 * @param e The indexed row.
 */
export function complianceEventOf(e: ChainEvent): ComplianceEventLike | null {
  if (e.ref === null || e.account === null || e.flagValue === null) return null;
  const base = {
    blockNumber: e.blockNumber,
    blockHash: e.blockHash as `0x${string}`,
    ref: e.ref as `0x${string}`,
    account: e.account as `0x${string}`,
  };
  if (e.kind === 'VerificationSet')
    return { ...base, kind: 'VerificationSet', verified: e.flagValue };
  if (e.kind === 'FrozenSet') return { ...base, kind: 'FrozenSet', frozen: e.flagValue };
  return null;
}

/**
 * What a compliance change writes on chain, as the domain compares it with a registry event.
 *
 * @param change The change row.
 * @param account The user's wallet (lowercase).
 */
export function complianceContentOf(
  change: Pick<ComplianceChange, 'ref' | 'action'>,
  account: string,
): ComplianceChangeContent {
  const f = flagChangeFor(change.action);
  return {
    ref: change.ref as `0x${string}`,
    account: account as `0x${string}`,
    flag: f.flag,
    value: f.value,
  };
}

/** Watches submitted and failed compliance changes and moves them on final evidence. */
export class ComplianceMonitor {
  private readonly prisma: PrismaClient;
  private readonly gateway: ChainGateway;
  private readonly inspector: RawTransactionInspector;
  private readonly clock: Clock;
  private readonly binding: DeploymentBinding;
  private readonly policy: MonitorPolicy;
  private readonly alarms: AlarmSink;
  private readonly transactions: TransactionOptions;
  private readonly redaction: SanitizeOptions;
  private readonly skips = new Map<string, number>();
  private readonly pendingAlarmAfterSeconds: number;
  private readonly failedLookbackSeconds: number;

  /** @param options Database, gateway, inspector, clock, policy and alarm sink. */
  constructor(options: ComplianceMonitorOptions) {
    const p = options.policy;
    if (!Number.isSafeInteger(p.confirmationDepth) || p.confirmationDepth < 1) {
      throw new RangeError('confirmationDepth must be an integer >= 1');
    }
    this.pendingAlarmAfterSeconds =
      options.pendingAlarmAfterSeconds ?? DEFAULT_COMPLIANCE_PENDING_ALARM_SECONDS;
    this.failedLookbackSeconds =
      options.failedLookbackSeconds ?? DEFAULT_COMPLIANCE_FAILED_LOOKBACK_SECONDS;
    for (const [name, v] of [
      ['pendingAlarmAfterSeconds', this.pendingAlarmAfterSeconds],
      ['failedLookbackSeconds', this.failedLookbackSeconds],
    ] as const) {
      if (!Number.isSafeInteger(v) || v < 0)
        throw new RangeError(`${name} must be an integer >= 0`);
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

  /** One pass over every submitted and failed compliance change of the bound deployment. */
  async runOnce(): Promise<ComplianceMonitorSummary> {
    const counts: Record<Outcome, number> = {
      confirmed: 0,
      lateConfirmed: 0,
      failed: 0,
      bumped: 0,
      resubmitted: 0,
    };
    const deployment = await loadBoundDeployment(this.prisma, this.binding);
    if (deployment === null) return EMPTY_COMPLIANCE_SUMMARY;
    let view: ChainView;
    try {
      view = await this.readChainView(deployment);
    } catch {
      // Unknown (obligation 3): nothing is decided on a failed read. The transaction monitor
      // counts unreachable passes and raises node_unreachable for the shared node.
      return EMPTY_COMPLIANCE_SUMMARY;
    }
    const changes = await this.changesToExamine(deployment);
    let skipped = 0;
    let examined = 0;
    for (const change of changes) {
      let evidence: Evidence;
      try {
        evidence = await this.gather(change, deployment, view);
      } catch (err) {
        skipped += 1;
        const n = (this.skips.get(change.id) ?? 0) + 1;
        this.skips.set(change.id, n);
        if (n >= this.policy.skipAlarmPasses) {
          this.alarm(
            'operation_skipped',
            `compliance evidence read failed ${n} pass(es) in a row: ${describeError(err, this.redaction)}`,
            change.id,
          );
        }
        continue;
      }
      this.skips.delete(change.id);
      // A failed change with nothing recorded and nothing on chain needs no further look.
      if (change.status === 'failed' && evidence.events.length === 0) continue;
      examined += 1;
      try {
        const outcome = await this.decide(change, deployment, view, evidence);
        if (outcome !== null) counts[outcome] += 1;
      } catch (err) {
        if (err instanceof ComplianceVersionConflictError) continue;
        this.alarm('examine_error', describeError(err, this.redaction), change.id);
      }
    }
    await this.alarmPending(deployment);
    try {
      counts.failed += await this.sweepOrphans(deployment);
    } catch (err) {
      if (!(err instanceof ComplianceVersionConflictError)) {
        this.alarm('examine_error', describeError(err, this.redaction));
      }
    }
    return { ran: true, head: view.head, examined, skipped, ...counts };
  }

  /**
   * Submitted changes, plus FAILED changes updated within the look-back or whose reference an
   * indexed event carries (step 7, L-3), in decision order.
   */
  private async changesToExamine(d: Deployment): Promise<ChangeWithWallet[]> {
    const cutoff = new Date(this.clock.now().getTime() - this.failedLookbackSeconds * 1000);
    const withEvents = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT c.id::text AS id FROM compliance_change c
       WHERE c.deployment_id = ${d.id}::uuid AND c.status = 'failed' AND c.updated_at < ${cutoff}
         AND EXISTS (SELECT 1 FROM chain_event e
                      WHERE e.deployment_id = c.deployment_id AND e.ref = c.ref)`;
    return this.prisma.complianceChange.findMany({
      where: {
        deploymentId: d.id,
        OR: [
          { status: 'submitted' },
          { status: 'failed', updatedAt: { gte: cutoff } },
          { id: { in: withEvents.map((r) => r.id) } },
        ],
      },
      include: { user: { select: { walletAddress: true } } },
      orderBy: [{ decisionSeq: 'asc' }],
    });
  }

  /** `compliance_pending` for every change still not applied after the limit, freezes first. */
  private async alarmPending(d: Deployment): Promise<void> {
    const before = new Date(this.clock.now().getTime() - this.pendingAlarmAfterSeconds * 1000);
    const pending = await this.prisma.complianceChange.findMany({
      where: {
        deploymentId: d.id,
        status: { in: ['requested', 'submitted'] },
        createdAt: { lte: before },
      },
      orderBy: [{ decisionSeq: 'asc' }],
    });
    const rank = (a: string): number => (a === 'freeze' ? 0 : 1);
    pending.sort((a, b) => rank(a.action) - rank(b.action));
    for (const c of pending) {
      const minutes = Math.floor((this.clock.now().getTime() - c.createdAt.getTime()) / 60_000);
      this.alarm(
        'compliance_pending',
        `${c.action} still ${c.status} after ${minutes} min${c.action === 'freeze' ? ' (FREEZE: page first)' : ''}`,
        c.id,
      );
    }
  }

  /**
   * Step 7 (M-1): after a change is confirmed at `block`, any other CONFIRMED change for the same
   * account and flag whose block is out of decision order raises `compliance_out_of_order`.
   */
  private async checkDecisionOrder(change: ChangeWithWallet, block: bigint): Promise<void> {
    const flag = flagChangeFor(change.action).flag;
    const same: ComplianceChange['action'][] =
      flag === 'frozen' ? ['freeze', 'unfreeze'] : ['verify', 'unverify'];
    const others = await this.prisma.complianceChange.findMany({
      where: {
        deploymentId: change.deploymentId,
        userId: change.userId,
        action: { in: same },
        status: 'confirmed',
        id: { not: change.id },
      },
      select: { id: true, decisionSeq: true, confirmedBlock: true },
    });
    for (const o of others) {
      if (o.confirmedBlock === null) continue;
      const inverted =
        (o.decisionSeq > change.decisionSeq && o.confirmedBlock < block) ||
        (o.decisionSeq < change.decisionSeq && o.confirmedBlock > block);
      if (inverted) {
        this.alarm(
          'compliance_out_of_order',
          `${change.action} (decision ${change.decisionSeq}) landed in block ${block}, out of ` +
            `decision order with change ${o.id} (decision ${o.decisionSeq}, block ${o.confirmedBlock}): ` +
            `the registry holds the older decision's ${flag} value`,
          change.id,
        );
      }
    }
  }

  /** Signer binding first, then head, then the compliance nonces at explicit blocks. */
  private async readChainView(d: Deployment): Promise<ChainView> {
    await assertSignerBound(
      this.prisma,
      this.gateway,
      d.id,
      (detail) => this.alarm('signer_mismatch', detail),
      'compliance',
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
    const confirmedNonce = (await this.gateway.getNonce('compliance', head)).confirmed;
    const finalNonce = (await this.gateway.getNonce('compliance', finalBlock)).confirmed;
    return { head, finalBlock, confirmedNonce, finalNonce };
  }

  private async gather(
    change: ChangeWithWallet,
    d: Deployment,
    view: ChainView,
  ): Promise<Evidence> {
    const attempts = await this.prisma.chainAttempt.findMany({
      where: { outbox: { complianceChangeId: change.id }, deploymentId: d.id },
      include: { outbox: { select: { call: true } } },
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
      where: { deploymentId: d.id, ref: change.ref },
      orderBy: [{ blockNumber: 'asc' }, { logIndex: 'asc' }],
    });
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
      content: complianceContentOf(change, change.user.walletAddress),
    };
  }

  /** Steps 3 to 5 of the file comment for one change. */
  private async decide(
    change: ChangeWithWallet,
    d: Deployment,
    view: ChainView,
    ev: Evidence,
  ): Promise<Outcome | null> {
    // Only registry events on the node's canonical block at that height (obligation 9).
    const canonical = ev.events
      .filter((e) => ev.finality.canonicalBlockHashes.get(e.blockNumber) === e.blockHash)
      .map((e) => ({ row: e, like: complianceEventOf(e) }))
      .filter((x): x is { row: ChainEvent; like: ComplianceEventLike } => x.like !== null);
    if (canonical.length > 1) {
      this.alarm(
        'compliance_escalation',
        `${canonical.length} canonical registry events carry the reference`,
        change.id,
      );
      return null;
    }
    const [found] = canonical;
    if (found !== undefined) {
      const judgement = judgeComplianceEvent(ev.content, found.like, ev.finality);
      if (judgement.verdict === 'wait') return null;
      if (judgement.verdict === 'confirm') {
        const move: ComplianceMove =
          change.status === 'failed'
            ? { event: 'CONFIRM_LATE', judgement, confirmedBlock: found.like.blockNumber }
            : { event: 'CONFIRM', judgement, confirmedBlock: found.like.blockNumber };
        await this.move(
          change,
          move,
          `registry event final in block ${found.like.blockNumber}`,
          found.row.txHash,
        );
        await this.checkDecisionOrder(change, found.like.blockNumber);
        return change.status === 'failed' ? 'lateConfirmed' : 'confirmed';
      }
      if (change.status === 'submitted') {
        await this.fail(
          change,
          'reference_conflict',
          'a final registry event under this reference writes something else',
        );
        return 'failed';
      }
      this.alarm(
        'compliance_escalation',
        'a failed compliance change has a conflicting registry event',
        change.id,
      );
      return null;
    }
    if (change.status !== 'submitted') return null;
    return this.decideSubmitted(change, d, view, ev);
  }

  private async decideSubmitted(
    change: ChangeWithWallet,
    d: Deployment,
    view: ChainView,
    ev: Evidence,
  ): Promise<Outcome | null> {
    const latest = ev.attempts[ev.attempts.length - 1];
    if (latest === undefined) {
      this.alarm(
        'missing_attempts',
        'submitted compliance change has no recorded attempt',
        change.id,
      );
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
      assessAttempt(
        attemptRecordOf(a, change.resubmitsSoFar),
        this.observation(ev, i),
        now,
        policy,
      ),
    );
    if (verdicts.some((v) => v.verdict === 'mined_unconfirmed')) return null;
    if (verdicts.some((v) => v.verdict === 'confirmed')) {
      // A successful final receipt is NOT a confirmation: only the registry event bound to the
      // reference is (the index may lag the receipt).
      this.alarm(
        'settled_without_event',
        'a final successful registry receipt has no indexed event yet',
        change.id,
      );
      return null;
    }
    const reverted = verdicts.find((v) => v.verdict === 'reverted');
    if (reverted !== undefined && reverted.verdict === 'reverted') {
      const used = reverted.reason === 'ReferenceAlreadyUsed';
      await this.fail(
        change,
        used ? 'duplicate_reference' : 'reverted',
        `registry call reverted in block ${reverted.blockNumber}${used ? ': reference already used' : ''}`,
      );
      return 'failed';
    }
    const verdict = verdicts[verdicts.length - 1];
    switch (verdict?.verdict) {
      case 'stuck_bump':
        await this.bump(change, d, latest, verdict.fees);
        return 'bumped';
      case 'dropped':
        return this.dropped(change, d, latest, now);
      case 'give_up':
        return this.givenUp(change, d, ev, view, verdict.why, now);
      case 'replaced_or_lost':
        return this.replacedOrLost(change, d, view, ev, verdicts);
      default:
        return null;
    }
  }

  /** Same as the transaction monitor: rebroadcast, or a same-nonce replacement at current fees. */
  private async dropped(
    change: ChangeWithWallet,
    d: Deployment,
    latest: AttemptWithCall,
    now: Date,
    counted = true,
  ): Promise<Outcome | null> {
    const lastSent = latest.lastCheckedAt ?? latest.submittedAt;
    if (now.getTime() - lastSent.getTime() < this.policy.dropRetrySeconds * 1000) return null;
    const estimate = await this.gateway.estimateFees();
    if (latest.maxFeePerGas >= estimate.maxFeePerGas) {
      return (await this.resubmitSame(change, latest, now, counted)) ? 'resubmitted' : null;
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
        `compliance nonce ${latest.nonce}: the fees the node asks exceed the fee cap`,
        change.id,
      );
      return null;
    }
    await this.bump(change, d, latest, fees);
    return 'bumped';
  }

  /** Never FAIL while the nonce is not final; keep rebroadcasting a dropped one (round 2, N-1). */
  private async givenUp(
    change: ChangeWithWallet,
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
        `compliance signer ${this.gateway.signerAddress('compliance')}: nonce ${view.finalNonce} ` +
          `is the lowest non-final nonce; this change's nonce ${latest.nonce} gave up (${why})`,
        change.id,
      );
    }
    if (why === 'max_resubmits' && notFinal) return this.dropped(change, d, latest, now, false);
    if (patient || notFinal) return null;
    await this.fail(
      change,
      why === 'max_resubmits' ? 'dropped' : 'retries_exhausted',
      `gave up: ${why}`,
    );
    return 'failed';
  }

  /** Every nonce we used is finally taken by something else: check the registry's flag first. */
  private async replacedOrLost(
    change: ChangeWithWallet,
    d: Deployment,
    view: ChainView,
    ev: Evidence,
    verdicts: readonly AttemptVerdict[],
  ): Promise<Outcome | null> {
    if (!verdicts.every((v) => v.verdict === 'replaced_or_lost')) return null;
    const used = await this.gateway.readReferenceUsed(
      'registry',
      change.ref as `0x${string}`,
      view.finalBlock,
    );
    if (used || ev.events.length > 0) {
      this.alarm(
        'compliance_escalation',
        'the reference is used on the registry but no registry event was judged for it',
        change.id,
      );
      return null;
    }
    const newNonces = new Set(ev.attempts.map((a) => a.nonce)).size - 1;
    if (newNonces >= this.policy.maxResubmits) {
      await this.fail(change, 'retries_exhausted', 'nonce taken and resubmissions exhausted');
      return 'failed';
    }
    await this.resubmitNewNonce(change, d, ev);
    return 'resubmitted';
  }

  /**
   * A `requested` change with no attempt and no live outbox row, older than `orphanAfterSeconds`:
   * nothing was ever signed for it (an attempt is only inserted with SUBMIT `first`). FAIL it
   * (`rejected`) in one transaction that locks the change row and re-checks every condition.
   */
  private async sweepOrphans(d: Deployment): Promise<number> {
    const before = new Date(this.clock.now().getTime() - this.policy.orphanAfterSeconds * 1000);
    const candidates = await this.prisma.complianceChange.findMany({
      where: { deploymentId: d.id, status: 'requested', createdAt: { lte: before } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 50,
    });
    let failed = 0;
    for (const c of candidates) {
      const at = this.clock.now();
      const { value: done } = await runTransaction(
        this.prisma,
        async (tx) => {
          await lockRows(tx, 'compliance_change', [c.id]);
          const fresh = await tx.complianceChange.findUniqueOrThrow({ where: { id: c.id } });
          if (fresh.status !== 'requested' || fresh.version !== c.version) return false;
          const live = await tx.outboxMessage.count({
            where: { complianceChangeId: c.id, status: { in: ['pending', 'processing'] } },
          });
          const attempts = await tx.chainAttempt.count({
            where: { outbox: { complianceChangeId: c.id } },
          });
          if (live > 0 || attempts > 0) return false;
          await moveComplianceChange(tx, {
            changeId: c.id,
            from: 'requested',
            version: c.version,
            move: { event: 'FAIL', reason: 'rejected' },
            at,
            note: 'requested but never signed: its outbox row is gone',
          });
          return true;
        },
        this.transactions,
      );
      if (done) {
        failed += 1;
        this.alarm('orphan_released', 'compliance change never signed: failed', c.id);
      }
    }
    return failed;
  }

  private observation(ev: Evidence, i: number): AttemptObservation {
    const o = ev.observations[i];
    if (o === undefined) throw new RangeError(`no observation for attempt ${i}`);
    return o;
  }

  private async move(
    change: ComplianceChange,
    move: ComplianceMove,
    note: string,
    txHash?: string,
  ): Promise<void> {
    await runTransaction(
      this.prisma,
      (tx) =>
        moveComplianceChange(tx, {
          changeId: change.id,
          from: change.status,
          version: change.version,
          move,
          at: this.clock.now(),
          note,
          ...(txHash !== undefined ? { txHash: txHash as `0x${string}` } : {}),
        }),
      this.transactions,
    );
  }

  /** FAIL from submitted; an escalation reason also gets an audit row and an alarm. */
  private async fail(change: ComplianceChange, reason: FailureReason, note: string): Promise<void> {
    const escalate = reason === 'reference_conflict' || reason === 'duplicate_reference';
    const at = this.clock.now();
    await runTransaction(
      this.prisma,
      async (tx) => {
        await moveComplianceChange(tx, {
          changeId: change.id,
          from: 'submitted',
          version: change.version,
          move: { event: 'FAIL', reason },
          at,
          note,
        });
        if (escalate) {
          await writeAudit(
            tx,
            auditEntryFor({
              entity: 'compliance_change',
              entityId: change.id,
              fromState: 'failed',
              toState: 'escalated',
              detail: `${reason}: a person decides; the registry may hold another value`,
              at,
            }),
            { failureReason: reason },
          );
        }
      },
      this.transactions,
    );
    if (escalate) this.alarm('compliance_escalation', reason, change.id);
  }

  private async bump(
    change: ComplianceChange,
    d: Deployment,
    latest: AttemptWithCall,
    fees: Fees,
  ): Promise<void> {
    const call = contractCallFromJson(latest.outbox.call);
    const request = { signer: latest.signer, call, nonce: latest.nonce, fees };
    const expected = await signingExpectationFor(this.prisma, d, 'compliance');
    const signed = await signAndVerify(this.gateway, this.inspector, request, expected);
    const { value: attempt } = await runTransaction(
      this.prisma,
      async (tx) => {
        const at = this.clock.now();
        await moveComplianceChange(tx, {
          changeId: change.id,
          from: 'submitted',
          version: change.version,
          move: { event: 'SUBMIT', kind: 'bump' },
          at,
          txHash: signed.hash,
          note: `fee bump of compliance nonce ${latest.nonce}`,
        });
        return insertAttempt(tx, {
          deploymentId: d.id,
          outboxId: latest.outboxId,
          request,
          signed,
          contractAddress: d.registryAddress,
          bumpsSoFar: latest.bumpsSoFar + 1,
          at,
        });
      },
      this.transactions,
    );
    await this.broadcast(change, attempt);
  }

  private async resubmitSame(
    change: ComplianceChange,
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
          await moveComplianceChange(tx, {
            changeId: change.id,
            from: 'submitted',
            version: change.version,
            move: { event: 'SUBMIT', kind: 'resubmit', resubmitsSoFar: change.resubmitsSoFar },
            at: now,
            txHash: latest.hash as `0x${string}`,
            note: `rebroadcast of compliance nonce ${latest.nonce} after a drop`,
          });
        }
        return true;
      },
      this.transactions,
    );
    if (!stamped) return false;
    await this.broadcast(change, latest);
    return true;
  }

  private async resubmitNewNonce(
    change: ComplianceChange,
    d: Deployment,
    ev: Evidence,
  ): Promise<void> {
    const latest = ev.attempts[ev.attempts.length - 1];
    if (latest === undefined) return;
    const call: ContractCall = contractCallFromJson(latest.outbox.call);
    const signerAddress = this.gateway.signerAddress('compliance');
    const { pending } = await this.gateway.getNonce('compliance');
    const fees = initialFees(await this.gateway.estimateFees(), {
      marginBps: this.policy.initialFeeMarginBps,
      cap: this.policy.feeCap,
    });
    const attempt = await commitWithFreshNonce({
      prisma: this.prisma,
      gateway: this.gateway,
      inspector: this.inspector,
      expected: await signingExpectationFor(this.prisma, d, 'compliance'),
      allocation: {
        deploymentId: d.id,
        signer: 'compliance',
        signerAddress,
        chainPending: pending,
      },
      build: (nonce) => ({ signer: 'compliance', call, nonce, fees }),
      commit: async (tx, request, signed) => {
        const at = this.clock.now();
        await moveComplianceChange(tx, {
          changeId: change.id,
          from: 'submitted',
          version: change.version,
          move: { event: 'SUBMIT', kind: 'resubmit', resubmitsSoFar: change.resubmitsSoFar },
          at,
          txHash: signed.hash,
          note: `resubmitted with new compliance nonce ${request.nonce}: the old nonce was finally used elsewhere`,
        });
        return insertAttempt(tx, {
          deploymentId: d.id,
          outboxId: latest.outboxId,
          request,
          signed,
          contractAddress: d.registryAddress,
          bumpsSoFar: 0,
          at,
        });
      },
      transactions: this.transactions,
    });
    await this.broadcast(change, attempt);
  }

  private async broadcast(change: ComplianceChange, attempt: ChainAttempt): Promise<void> {
    const result = await broadcastAttempt(this.gateway, attempt);
    await recordBroadcast(
      this.prisma,
      attempt,
      result,
      { entity: 'compliance_change', id: change.id, state: 'submitted' },
      this.clock.now(),
      this.redaction,
    );
  }

  private alarm(kind: AlarmKind, detail: string, complianceChangeId?: string): void {
    this.alarms.raise({
      kind,
      detail,
      ...(complianceChangeId !== undefined ? { complianceChangeId } : {}),
      at: this.clock.now(),
    });
  }
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
