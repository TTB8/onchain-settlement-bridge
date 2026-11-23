/**
 * @file The reconciler: the bridge's own proof of reserve. It compares the ledger with the chain
 * at ONE final block, through the domain's pure `reconcile`, and records every run (clean, with
 * mismatches, or UNKNOWN) so nothing it saw is lost.
 *
 * A run (`runOnce` / `reconcileNow`), never holding a transaction across a node read:
 *
 * 1. Chain id and head from the NODE, then `finalBlock = max(0, head - depth + 1)`
 *    (checklist 15).
 * 2. DB snapshot, in one short read-only REPEATABLE READ transaction (so every table is read at
 *    one instant): every operation of the bound deployment with its parties' wallets, those users'
 *    ledger balances (`readBalances`: available + held is what the chain must hold for them),
 *    every compliance change with its account and `decision_seq`, the indexed events, the
 *    indexer's cursor, the indexer's hash AT `finalBlock` (the anchor), and whether a ledger user
 *    also has operations on another deployment.
 * 3. Anchor (review L-1): the node's hash at `finalBlock` must equal the indexed one, else the
 *    index is on another fork at or below the final block.
 * 4. Node reads, ALL at `finalBlock` (never the head): the canonical hash of every block that
 *    holds an indexed event up to `finalBlock` (from the node, never from `indexed_block`:
 *    checklist 15); balances of EXACTLY the relevant set (every ledger address, plus both sides of
 *    every indexed `Transfer`: checklist 16) and the total supply; registry flags for that set plus
 *    every account a registry event or a known change touched (checklist 16).
 * 5. Expected flags: per account and flag, the latest APPLIED decision by `decision_seq`
 *    (`deriveExpectedCompliance`, checklist 13, review M-1). Never the database's confirmation
 *    order, never the app clock.
 * 6. `reconcile` from `@bridge/domain`, then ONE transaction: the run, one row per mismatch, an
 *    audit row. Then one alarm per mismatch kind present (`reconciliation_<kind>`); a failing
 *    alarm sink is recorded as an audit row, never as a second run.
 *
 * UNKNOWN, never clean: any read error, an index behind the final block, an anchor mismatch, a
 * ledger behind the chain (an in-flight operation whose settling event is already final: the
 * monitor has not caught up), a ledger user with operations on another deployment
 * (`multi_deployment_user`: ledger balances are per user, not per deployment), or inputs the
 * domain refuses (for example a confirmation newer than this run's final block, when another
 * worker confirmed between the head read and the snapshot) record an `unknown` run with the
 * redacted reason and raise `reconciliation_unknown`.
 *
 * What a run catches, by construction: a rogue transfer (a `Transfer` with no reference event in
 * the transaction: `unexplained_transfer`, and the balances it moved: `balance_mismatch`); a rogue
 * mint/burn (an unknown reference, a supply and balance mismatch); a rogue or front-run registry
 * change (`compliance_event_mismatch`, and the flag it changed: `compliance_mismatch`); an old
 * decision landing after a newer one (`compliance_mismatch`); a confirmation the chain never made
 * (`missing_onchain`) or made elsewhere (`confirmed_block_mismatch`).
 */

import type { ChainGateway } from '@bridge/chain';
import {
  bigintsToDecimal,
  type ChainEvent,
  type ComplianceChangeStatus,
  type Deployment,
  Prisma,
  type PrismaClient,
  readBalances,
  type ReconciliationRun,
  type ReconciliationStatus,
} from '@bridge/db';
import {
  type Address,
  auditEntryFor,
  type Bytes32,
  type ComplianceChangeContent,
  complianceEventMatches,
  type ComplianceState,
  type Hex,
  type LedgerOperationView,
  type Mismatch,
  type ObservedEvent,
  type OperationParties,
  reconcile,
  type ReconciliationReport,
  ZERO_ADDRESS,
} from '@bridge/domain';

import type { AlarmKind, AlarmSink } from './alarms';
import { complianceContentOf } from './compliance-monitor';
import { writeAudit } from './ledger-writes';
import type { Clock } from './ports';
import { describeError, sanitizeText, type SanitizeOptions } from './redact';
import { bindingOf, type DeploymentBinding, loadBoundDeployment } from './signer-binding';
import { runTransaction } from './transaction';

/** Reconciler settings. */
export interface ReconcilerPolicy {
  /** Confirmations before a block is final (>= 1): `finalBlock = head - depth + 1`. */
  readonly confirmationDepth: number;
}

/** Construction options for `Reconciler`. */
export interface ReconcilerOptions {
  /** The database. */
  readonly prisma: PrismaClient;
  /** The chain; its own `deployment()` is the binding. */
  readonly gateway: ChainGateway;
  /** The time source. */
  readonly clock: Clock;
  /** Depth. */
  readonly policy: ReconcilerPolicy;
  /** Where alarms go. */
  readonly alarms: AlarmSink;
  /** Literal secrets removed from every error text written. */
  readonly secrets?: readonly string[];
}

/** One stored mismatch: its position in the run's report, its kind, and the mismatch (JSON). */
export interface StoredMismatch {
  /** Position in the run's (deterministic) order. */
  readonly ordinal: number;
  /** The domain's mismatch kind. */
  readonly kind: Mismatch['kind'];
  /** The mismatch, bigints as decimal strings. */
  readonly detail: Readonly<Record<string, unknown>>;
}

/** A persisted run and its mismatches, as read back from the database. */
export interface ReconciliationRunRecord {
  /** The run id. */
  readonly id: string;
  /** The deployment. */
  readonly deploymentId: string;
  /** ok, mismatch or unknown. */
  readonly status: ReconciliationStatus;
  /** The block compared at (the final block); null when the run never got that far. */
  readonly atBlock: bigint | null;
  /** The final block. */
  readonly finalBlock: bigint | null;
  /** The head it was derived from. */
  readonly headBlock: bigint | null;
  /** Why an unknown run is unknown; null otherwise. */
  readonly error: string | null;
  /** How many mismatches. */
  readonly mismatchCount: number;
  /** What the run saw (counts). */
  readonly summary: Readonly<Record<string, unknown>>;
  /** When it started and finished (from the injected clock). */
  readonly startedAt: Date;
  /** When it finished. */
  readonly finishedAt: Date | null;
  /** Its mismatches, in order. */
  readonly mismatches: readonly StoredMismatch[];
}

/** A registry event as `deriveExpectedCompliance` reads it. */
type RegistryEvent = Extract<ObservedEvent, { kind: 'VerificationSet' | 'FrozenSet' }>;

/** A known compliance change as `deriveExpectedCompliance` reads it. */
export interface KnownComplianceChange {
  /** What it writes. */
  readonly content: ComplianceChangeContent;
  /** Its status (only a `confirmed` change is a settled decision). */
  readonly status: ComplianceChangeStatus;
  /**
   * The order of the bridge's DECISIONS (`compliance_change.decision_seq`, assigned by the
   * database at insert; review M-1): never the app clock, never the order of confirmations.
   */
  readonly decisionSeq: bigint;
}

/** Inputs to `deriveExpectedCompliance`. */
export interface ExpectedComplianceInput {
  /** Addresses that need an expectation (holders, ledger parties, touched accounts). */
  readonly addresses: Iterable<Address>;
  /** FINAL events on CANONICAL blocks (the caller filters). Any order. */
  readonly events: readonly ObservedEvent[];
  /** Every compliance change the bridge recorded, in any order. */
  readonly changes: readonly KnownComplianceChange[];
}

const NOT_SET: ComplianceState = Object.freeze({ verified: false, frozen: false });

function isRegistryEvent(e: ObservedEvent): e is RegistryEvent {
  return e.kind === 'VerificationSet' || e.kind === 'FrozenSet';
}

/**
 * The flags the bridge expects each address to have (checklist 13, reviews N-7 and C/M-1). Pure.
 *
 * 1. Every address starts as the registry's default (not verified, not frozen).
 * 2. A decision is APPLIED when it is `confirmed`, or when a final event on a canonical block
 *    matches it exactly (reference, account, flag, value): the chain has applied it even if the
 *    monitor has not recorded that yet. A failed or in-flight decision with no such event has
 *    changed nothing, so it is not applied. Rogue or front-run events match no decision and never
 *    move an expectation (reconcile reports them, and the flag they changed, separately).
 * 3. Per (account, flag), the APPLIED decision with the highest `decisionSeq` (assigned by the
 *    database at insert: the order of DECISIONS) is the expectation. The filter comes BEFORE the
 *    choice (review M-1): a newer decision that failed or is still in flight must not hide an
 *    older applied one.
 *
 * Why the chain's own order does not pick the value: the registry ALREADY holds the chain-ordered
 * result, and that is what `observedCompliance` reads at the final block. Expecting the newest
 * decision and observing the chain-ordered state is exactly what turns an old decision landing
 * late into a `compliance_mismatch` (a finding for a person). The compliance monitor also raises
 * `compliance_out_of_order` when it confirms such a change. Neither the order in which the
 * database confirmed changes nor the app clock plays any part.
 *
 * @param input The addresses, the final canonical events and the known changes.
 */
export function deriveExpectedCompliance(
  input: ExpectedComplianceInput,
): Map<Address, ComplianceState> {
  const out = new Map<Address, ComplianceState>();
  const touch = (a: Address): void => {
    if (!out.has(a)) out.set(a, NOT_SET);
  };
  for (const a of input.addresses) touch(a);
  for (const c of input.changes) touch(c.content.account);

  const onChain = new Set<Bytes32>();
  const byRef = new Map<Bytes32, ComplianceChangeContent>();
  for (const c of input.changes) byRef.set(c.content.ref, c.content);
  for (const e of input.events) {
    if (!isRegistryEvent(e)) continue;
    touch(e.account);
    const known = byRef.get(e.ref);
    if (known !== undefined && complianceEventMatches(known, e)) onChain.add(e.ref);
  }

  const latest = new Map<string, KnownComplianceChange>();
  for (const c of input.changes) {
    if (c.status !== 'confirmed' && !onChain.has(c.content.ref)) continue;
    const key = `${c.content.account}:${c.content.flag}`;
    const prev = latest.get(key);
    if (prev === undefined || c.decisionSeq > prev.decisionSeq) latest.set(key, c);
  }
  for (const c of latest.values()) {
    const { account, flag, value } = c.content;
    const state = out.get(account) ?? NOT_SET;
    out.set(
      account,
      flag === 'verified' ? { ...state, verified: value } : { ...state, frozen: value },
    );
  }
  return out;
}

/** An indexed row as the domain's `ObservedEvent`. Throws for a row missing a field. */
export function observedEventOf(e: ChainEvent): ObservedEvent {
  const position = {
    blockNumber: e.blockNumber,
    blockHash: e.blockHash as Hex,
    txHash: e.txHash as `0x${string}`,
    logIndex: e.logIndex,
  };
  const need = <T>(v: T | null, name: string): T => {
    if (v === null) throw new RangeError(`indexed ${e.kind} event ${e.id} has no ${name}`);
    return v;
  };
  const amount = (): bigint => BigInt(need(e.amount, 'amount').toFixed());
  const addr = (v: string | null, name: string): Address => need(v, name) as Address;
  const ref = (): Bytes32 => need(e.ref, 'ref') as Bytes32;
  switch (e.kind) {
    case 'Minted':
      return {
        ...position,
        kind: 'Minted',
        to: addr(e.toAddress, 'to'),
        amount: amount(),
        ref: ref(),
      };
    case 'Burned':
      return {
        ...position,
        kind: 'Burned',
        from: addr(e.fromAddress, 'from'),
        amount: amount(),
        ref: ref(),
      };
    case 'SettledTransfer':
      return {
        ...position,
        kind: 'SettledTransfer',
        from: addr(e.fromAddress, 'from'),
        to: addr(e.toAddress, 'to'),
        amount: amount(),
        ref: ref(),
      };
    case 'Transfer':
      return {
        ...position,
        kind: 'Transfer',
        from: addr(e.fromAddress, 'from'),
        to: addr(e.toAddress, 'to'),
        amount: amount(),
      };
    case 'VerificationSet':
      return {
        ...position,
        kind: 'VerificationSet',
        account: addr(e.account, 'account'),
        verified: need(e.flagValue, 'flag'),
        ref: ref(),
      };
    case 'FrozenSet':
      return {
        ...position,
        kind: 'FrozenSet',
        account: addr(e.account, 'account'),
        frozen: need(e.flagValue, 'flag'),
        ref: ref(),
      };
  }
}

/** Why a run is unknown (a stable prefix of its `error`). */
class UnknownRun extends Error {}

/** The DB snapshot of step 1. */
interface Snapshot {
  readonly operations: readonly LedgerOperationView[];
  readonly expectedBalances: ReadonlyMap<Address, bigint>;
  readonly ledgerAddresses: readonly Address[];
  readonly changes: readonly KnownComplianceChange[];
  readonly events: readonly ObservedEvent[];
  readonly lastIndexed: bigint | null;
  /** The indexer's hash at `finalBlock` (the anchor), or null when it has none. */
  readonly anchorHash: string | null;
  /** Ledger users of this deployment that also have operations on another deployment. */
  readonly multiDeploymentUsers: number;
}

const IN_FLIGHT = new Set(['ledger_reserved', 'submitted']);

/** The alarm each mismatch kind raises (kind-specific, so monitoring can page on each). */
export const RECONCILIATION_ALARMS: Readonly<Record<Mismatch['kind'], AlarmKind>> = Object.freeze({
  missing_onchain: 'reconciliation_missing_onchain',
  amount_mismatch: 'reconciliation_amount_mismatch',
  address_mismatch: 'reconciliation_address_mismatch',
  confirmed_block_mismatch: 'reconciliation_confirmed_block_mismatch',
  unexpected_onchain_event: 'reconciliation_unexpected_onchain_event',
  unexplained_transfer: 'reconciliation_unexplained_transfer',
  balance_mismatch: 'reconciliation_balance_mismatch',
  supply_mismatch: 'reconciliation_supply_mismatch',
  compliance_event_mismatch: 'reconciliation_compliance_event_mismatch',
  compliance_mismatch: 'reconciliation_compliance_mismatch',
});
const SETTLING = new Set(['Minted', 'Burned', 'SettledTransfer']);

/** Compares the ledger with the chain and records every run. See the file comment. */
export class Reconciler {
  private readonly prisma: PrismaClient;
  private readonly gateway: ChainGateway;
  private readonly clock: Clock;
  private readonly binding: DeploymentBinding;
  private readonly depth: number;
  private readonly alarms: AlarmSink;
  private readonly redaction: SanitizeOptions;

  /** @param options Database, gateway, clock, depth and alarm sink. */
  constructor(options: ReconcilerOptions) {
    const depth = options.policy.confirmationDepth;
    if (!Number.isSafeInteger(depth) || depth < 1) {
      throw new RangeError('confirmationDepth must be an integer >= 1');
    }
    this.prisma = options.prisma;
    this.gateway = options.gateway;
    this.clock = options.clock;
    this.binding = bindingOf(options.gateway);
    this.depth = depth;
    this.alarms = options.alarms;
    this.redaction = { secrets: [...(options.secrets ?? [])] };
  }

  /**
   * The entry point an admin endpoint calls: one run now, persisted, returned with its
   * mismatches as stored. Null only when the gateway's deployment has no row (nothing to bind a
   * run to).
   */
  reconcileNow(): Promise<ReconciliationRunRecord | null> {
    return this.runOnce();
  }

  /** One run (see the file comment). Null only when the bound deployment has no row. */
  async runOnce(): Promise<ReconciliationRunRecord | null> {
    const deployment = await loadBoundDeployment(this.prisma, this.binding);
    if (deployment === null) return null;
    const startedAt = this.clock.now();
    let head: bigint | null = null;
    let finalBlock: bigint | null = null;
    let report: ReconciliationReport | null = null;
    let error: string | null = null;
    try {
      const chainId = await this.gateway.getChainId();
      if (BigInt(chainId) !== this.binding.chainId) {
        throw new UnknownRun(`chain_mismatch: node reports chain ${chainId}`);
      }
      head = await this.gateway.getHeadBlock();
      const lag = head - BigInt(this.depth) + 1n;
      finalBlock = lag > 0n ? lag : 0n;
      const snapshot = await this.snapshot(deployment, finalBlock);
      if (snapshot.multiDeploymentUsers > 0) {
        // Ledger balances are per user, not per deployment: the expected balances would mix in
        // another deployment's money (README "Known limits").
        throw new UnknownRun(
          `multi_deployment_user: ${snapshot.multiDeploymentUsers} user(s) also have operations on another deployment`,
        );
      }
      if (snapshot.lastIndexed === null || snapshot.lastIndexed < finalBlock) {
        throw new UnknownRun(
          `index_behind: indexed up to ${String(snapshot.lastIndexed)}, final block is ${finalBlock}`,
        );
      }
      await this.checkAnchor(deployment, snapshot, finalBlock);
      report = await this.compare(snapshot, finalBlock);
    } catch (err) {
      // Bounded and redacted again as a whole: the stored error is at most 1000 characters.
      error = sanitizeText(
        err instanceof UnknownRun
          ? err.message
          : `read_failed: ${describeError(err, this.redaction)}`,
        this.redaction,
      );
      report = null;
    }
    // Outside the try: a failure AFTER the outcome is known (persisting, alarming) must never be
    // recorded as a second, `unknown` run.
    return this.persist(deployment, startedAt, { head, finalBlock, report, error });
  }

  /**
   * Review L-1: the index must be on the node's chain AT the final block. The indexer's stored
   * hash at `finalBlock` (read in the snapshot) must equal the node's hash there; a fork below or
   * at the final block changes it. Missing or different: `unknown` (`anchor_mismatch`). A final
   * block below the deployment block has nothing indexed yet and no event to vouch for.
   */
  private async checkAnchor(d: Deployment, s: Snapshot, finalBlock: bigint): Promise<void> {
    if (finalBlock < d.deploymentBlock) return;
    const block = await this.gateway.getBlock(finalBlock);
    if (block === null || s.anchorHash === null || block.hash.toLowerCase() !== s.anchorHash) {
      throw new UnknownRun(
        `anchor_mismatch: at final block ${finalBlock} the index holds ${String(s.anchorHash)}, ` +
          `the node ${block === null ? 'has no block' : block.hash}`,
      );
    }
  }

  /**
   * The newest runs of the bound deployment, newest first, with their mismatches.
   *
   * @param limit How many (1..100). Default 20.
   */
  async latestRuns(limit = 20): Promise<ReconciliationRunRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('limit must be an integer in 1..100');
    }
    const deployment = await loadBoundDeployment(this.prisma, this.binding);
    if (deployment === null) return [];
    const runs = await this.prisma.reconciliationRun.findMany({
      where: { deploymentId: deployment.id },
      include: { mismatchRows: { orderBy: { ordinal: 'asc' } } },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return runs.map((r) => toRecord(r, r.mismatchRows));
  }

  /** Step 1: one consistent read of everything the ledger says. No node call inside. */
  private async snapshot(d: Deployment, finalBlock: bigint): Promise<Snapshot> {
    const { value } = await runTransaction(
      this.prisma,
      async (tx) => {
        const ops = await tx.operation.findMany({
          where: { deploymentId: d.id },
          include: {
            user: { select: { walletAddress: true } },
            counterpartyUser: { select: { walletAddress: true } },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        const userIds = new Set<string>();
        const wallets = new Map<string, Address>();
        for (const o of ops) {
          userIds.add(o.userId);
          wallets.set(o.userId, o.user.walletAddress as Address);
          if (o.counterpartyUserId !== null && o.counterpartyUser !== null) {
            userIds.add(o.counterpartyUserId);
            wallets.set(o.counterpartyUserId, o.counterpartyUser.walletAddress as Address);
          }
        }
        const balances = await readBalances(tx, { userIds: [...userIds] });
        const expected = new Map<Address, bigint>();
        for (const b of balances) {
          // What the chain holds for a user: available + held (incoming is not minted yet).
          if (b.kind !== 'user_available' && b.kind !== 'user_held') continue;
          if (b.userId === null) continue;
          const w = wallets.get(b.userId);
          if (w === undefined) continue;
          expected.set(w, (expected.get(w) ?? 0n) + b.balance);
        }
        for (const [w, v] of [...expected]) if (v === 0n) expected.delete(w);
        const changes = await tx.complianceChange.findMany({
          where: { deploymentId: d.id },
          include: { user: { select: { walletAddress: true } } },
        });
        const events = await tx.chainEvent.findMany({
          where: { deploymentId: d.id },
          orderBy: [{ blockNumber: 'asc' }, { logIndex: 'asc' }],
        });
        const cursor = await tx.indexerState.findUnique({ where: { deploymentId: d.id } });
        const anchor = await tx.indexedBlock.findUnique({
          where: { deploymentId_number: { deploymentId: d.id, number: finalBlock } },
          select: { hash: true },
        });
        const multiDeploymentUsers = await tx.operation.count({
          where: {
            deploymentId: { not: d.id },
            OR: [{ userId: { in: [...userIds] } }, { counterpartyUserId: { in: [...userIds] } }],
          },
        });
        return {
          operations: ops.map((o): LedgerOperationView => {
            const from = o.user.walletAddress as Address;
            const to = (o.counterpartyUser?.walletAddress ?? from) as Address;
            const parties: OperationParties =
              o.type === 'deposit'
                ? { type: 'deposit', to: from }
                : o.type === 'withdrawal'
                  ? { type: 'withdrawal', from }
                  : { type: 'transfer', from, to };
            return {
              id: o.id,
              ref: o.ref as Bytes32,
              type: o.type,
              status: o.status,
              amount: o.amount,
              parties,
              confirmedBlock: o.confirmedBlock,
            };
          }),
          expectedBalances: expected,
          ledgerAddresses: [...new Set(wallets.values())],
          changes: changes.map((c) => ({
            content: complianceContentOf(c, c.user.walletAddress),
            status: c.status,
            decisionSeq: c.decisionSeq,
          })),
          events: events.map(observedEventOf),
          lastIndexed: cursor?.lastIndexedBlock ?? null,
          anchorHash: anchor?.hash ?? null,
          multiDeploymentUsers,
        };
      },
      // One instant for every table; read-only, so it never conflicts with a writer.
      { isolationLevel: 'RepeatableRead', maxAttempts: 1 },
    );
    return value;
  }

  /** Steps 3 and 4: node reads at `finalBlock`, the expectations, and the domain's comparison. */
  private async compare(s: Snapshot, finalBlock: bigint): Promise<ReconciliationReport> {
    const events = s.events.filter((e) => e.blockNumber <= finalBlock);
    // Canonical hashes from the node, never from indexed_block (checklist 15).
    const canonicalBlockHashes = new Map<bigint, Hex>();
    for (const n of new Set(events.map((e) => e.blockNumber))) {
      const block = await this.gateway.getBlock(n);
      if (block === null) {
        throw new UnknownRun(
          `node_inconsistent: no block ${n} at or below final block ${finalBlock}`,
        );
      }
      canonicalBlockHashes.set(n, block.hash);
    }
    const canonical = events.filter((e) => canonicalBlockHashes.get(e.blockNumber) === e.blockHash);

    // The ledger must have caught up with the chain up to finalBlock, else every in-flight
    // settlement already final on chain would show as a balance mismatch that is not a finding.
    const settledRefs = new Set(
      canonical.filter((e) => SETTLING.has(e.kind)).map((e) => ('ref' in e ? e.ref : '')),
    );
    const behind = s.operations.filter((o) => IN_FLIGHT.has(o.status) && settledRefs.has(o.ref));
    if (behind.length > 0) {
      throw new UnknownRun(
        `ledger_behind_chain: ${behind.length} in-flight operation(s) already settled at or below block ${finalBlock}`,
      );
    }

    // Balances for EXACTLY the relevant set: every ledger address, both sides of every Transfer.
    const balanceSet = new Set<Address>([...s.ledgerAddresses, ...s.expectedBalances.keys()]);
    for (const e of events) {
      if (e.kind !== 'Transfer') continue;
      balanceSet.add(e.from);
      balanceSet.add(e.to);
    }
    balanceSet.delete(ZERO_ADDRESS);
    const observedBalances = new Map<Address, bigint>();
    for (const a of balanceSet)
      observedBalances.set(a, await this.gateway.readBalance(a, finalBlock));
    const observedSupply = await this.gateway.readTotalSupply(finalBlock);

    // Flags for that set plus every account a registry event or a known change touched.
    const flagSet = new Set<Address>(balanceSet);
    for (const e of events)
      if (e.kind === 'VerificationSet' || e.kind === 'FrozenSet') flagSet.add(e.account);
    for (const c of s.changes) flagSet.add(c.content.account);
    flagSet.delete(ZERO_ADDRESS);
    const observedCompliance = new Map<Address, ComplianceState>();
    for (const a of flagSet) {
      const f = await this.gateway.readCompliance(a, finalBlock);
      observedCompliance.set(a, { verified: f.verified, frozen: f.frozen });
    }

    const expectedCompliance = deriveExpectedCompliance({
      addresses: flagSet,
      events: canonical,
      changes: s.changes,
    });
    let expectedSupply = 0n;
    for (const v of s.expectedBalances.values()) expectedSupply += v;
    const knownComplianceChanges = new Map<Bytes32, ComplianceChangeContent>(
      s.changes.map((c) => [c.content.ref, c.content]),
    );
    try {
      return reconcile({
        atBlock: finalBlock,
        finalBlock,
        operations: s.operations,
        events,
        observedBalances,
        observedSupply,
        expectedBalances: s.expectedBalances,
        expectedSupply,
        expectedCompliance,
        observedCompliance,
        knownComplianceChanges,
        canonicalBlockHashes,
      });
    } catch (err) {
      throw new UnknownRun(`invalid_input: ${describeError(err, this.redaction)}`);
    }
  }

  /** Step 5: the run, its mismatches and an audit row in ONE transaction; then the alarms. */
  private async persist(
    d: Deployment,
    startedAt: Date,
    r: {
      head: bigint | null;
      finalBlock: bigint | null;
      report: ReconciliationReport | null;
      error: string | null;
    },
  ): Promise<ReconciliationRunRecord> {
    const finishedAt = this.clock.now();
    const status: ReconciliationStatus =
      r.report === null ? 'unknown' : r.report.ok ? 'ok' : 'mismatch';
    const mismatches = (r.report?.mismatches ?? []).map(
      (m) => bigintsToDecimal(m) as Prisma.InputJsonObject,
    );
    const summary = {
      ignoredNoiseTransfers: r.report?.summary.ignoredNoiseTransfers ?? 0,
    };
    const run = await this.prisma.$transaction(async (tx) => {
      const created = await tx.reconciliationRun.create({
        data: {
          deploymentId: d.id,
          atBlock: r.report === null ? null : r.finalBlock,
          finalBlock: r.finalBlock,
          headBlock: r.head,
          status,
          mismatches,
          mismatchCount: mismatches.length,
          summary,
          error: r.error,
          startedAt,
          finishedAt,
        },
      });
      if (mismatches.length > 0) {
        await tx.reconciliationMismatch.createMany({
          data: mismatches.map((m, ordinal) => ({
            runId: created.id,
            ordinal,
            kind: String(m.kind),
            detail: m,
            createdAt: finishedAt,
          })),
        });
      }
      await writeAudit(
        tx,
        auditEntryFor({
          entity: 'reconciliation',
          entityId: created.id,
          fromState: null,
          toState: status,
          detail:
            r.error ?? `${mismatches.length} mismatch(es) at final block ${String(r.finalBlock)}`,
          at: finishedAt,
        }),
        {
          deploymentId: d.id,
          finalBlock: r.finalBlock === null ? null : r.finalBlock.toString(),
          headBlock: r.head === null ? null : r.head.toString(),
          mismatchCount: mismatches.length,
        },
      );
      return tx.reconciliationRun.findUniqueOrThrow({
        where: { id: created.id },
        include: { mismatchRows: { orderBy: { ordinal: 'asc' } } },
      });
    });
    try {
      this.raiseAlarms(run.id, status, r.error, r.report?.mismatches ?? []);
    } catch (err) {
      // The run is committed: a failing sink must not turn it into a second (unknown) run. Record
      // the failure next to the run instead (best effort: the database may be the problem too).
      await this.recordAlarmFailure(run.id, err);
    }
    return toRecord(run, run.mismatchRows);
  }

  /** An audit row saying the run's alarms could not be raised. Never throws. */
  private async recordAlarmFailure(runId: string, err: unknown): Promise<void> {
    try {
      await this.prisma.$transaction((tx) =>
        writeAudit(
          tx,
          auditEntryFor({
            entity: 'reconciliation',
            entityId: runId,
            fromState: null,
            toState: 'alarm_failed',
            detail: `alarm sink failed: ${describeError(err, this.redaction)}`,
            at: this.clock.now(),
          }),
        ),
      );
    } catch {
      // Nothing left to tell: the run itself is stored and readable via latestRuns.
    }
  }

  /** One alarm per mismatch kind present, or `reconciliation_unknown`. */
  private raiseAlarms(
    runId: string,
    status: ReconciliationStatus,
    error: string | null,
    mismatches: readonly Mismatch[],
  ): void {
    const at = this.clock.now();
    if (status === 'unknown') {
      this.alarms.raise({
        kind: 'reconciliation_unknown',
        detail: error ?? 'unknown',
        reconciliationRunId: runId,
        at,
      });
      return;
    }
    const byKind = new Map<Mismatch['kind'], number>();
    for (const m of mismatches) byKind.set(m.kind, (byKind.get(m.kind) ?? 0) + 1);
    for (const [kind, n] of byKind) {
      this.alarms.raise({
        kind: RECONCILIATION_ALARMS[kind],
        detail: `${n} ${kind} mismatch(es) in run ${runId}`,
        reconciliationRunId: runId,
        at,
      });
    }
  }
}

function toRecord(
  r: ReconciliationRun,
  rows: readonly { ordinal: number; kind: string; detail: Prisma.JsonValue }[],
): ReconciliationRunRecord {
  return {
    id: r.id,
    deploymentId: r.deploymentId,
    status: r.status,
    atBlock: r.atBlock,
    finalBlock: r.finalBlock,
    headBlock: r.headBlock,
    error: r.error,
    mismatchCount: r.mismatchCount,
    summary: (r.summary ?? {}) as Readonly<Record<string, unknown>>,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    mismatches: rows.map((m) => ({
      ordinal: m.ordinal,
      kind: m.kind as Mismatch['kind'],
      detail: m.detail as Readonly<Record<string, unknown>>,
    })),
  };
}
