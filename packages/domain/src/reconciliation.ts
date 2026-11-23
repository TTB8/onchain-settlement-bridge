/**
 * @file Reconciliation: comparing the ledger with the chain at one block and listing every
 * disagreement a person needs to look at.
 *
 * This is the bridge's own proof of reserve. The ledger says what should have happened; the chain
 * records what did. Each mismatch kind answers one question:
 *
 * - `missing_onchain`: the ledger settled an operation, the chain shows no event for it.
 * - `amount_mismatch` / `address_mismatch`: the event exists but moved a different amount, or
 *   between different addresses, than the ledger says.
 * - `unexpected_onchain_event`: a reference event the ledger cannot explain (unknown reference,
 *   an operation that failed or was reversed, a second event for one reference, the wrong kind),
 *   or any event from a block that is no longer canonical (`stale_block`: the index is stale).
 * - `unexplained_transfer`: tokens moved without one of our reference events in the same
 *   transaction. The contract should make this impossible; seeing one means a key or the contract
 *   is compromised.
 * - `balance_mismatch` / `supply_mismatch`: the totals disagree, whatever the cause.
 * - `compliance_event_mismatch`: a registry event the bridge did not make (unknown reference) or
 *   that writes something other than the change its reference names (e.g. a front-run).
 * - `compliance_mismatch`: the registry's flags differ from what the bridge believes, or an
 *   address that needs an expectation (a holder, an account a registry event touched) has none.
 *
 * Compliance checking is not optional: a compromised compliance key can do as much harm as a
 * compromised minter, so every registry event and every holder's flags are always checked.
 *
 * The function is pure and its output order is fixed (independent of input order), so two runs on
 * the same data produce byte-identical reports that can be diffed and stored.
 */

import {
  type ComplianceChangeContent,
  complianceEventContent,
  complianceEventMatches,
  type ComplianceState,
} from './compliance';
import { InvalidInputError } from './errors';
import {
  type OperationParties,
  type OperationStatus,
  type OperationType,
  type SettlementDifference,
  SETTLING_EVENT,
  settlementDifferences,
} from './operation';
import { type Address, type Bytes32, type Hex, type TxHash, ZERO_ADDRESS } from './primitives';

/** Where an observed event was emitted. Structurally identical to the chain's `EventPosition`. */
export interface ObservedEventPosition {
  /** Block height. */
  readonly blockNumber: bigint;
  /** Block hash. */
  readonly blockHash: `0x${string}`;
  /** The emitting transaction. */
  readonly txHash: TxHash;
  /** Position of the log within the block. */
  readonly logIndex: number;
}

/** An event read from the chain. Structurally identical to the chain package's `ChainEvent`. */
export type ObservedEvent = ObservedEventPosition &
  (
    | {
        readonly kind: 'Minted';
        readonly to: Address;
        readonly amount: bigint;
        readonly ref: Bytes32;
      }
    | {
        readonly kind: 'Burned';
        readonly from: Address;
        readonly amount: bigint;
        readonly ref: Bytes32;
      }
    | {
        readonly kind: 'SettledTransfer';
        readonly from: Address;
        readonly to: Address;
        readonly amount: bigint;
        readonly ref: Bytes32;
      }
    | {
        readonly kind: 'Transfer';
        readonly from: Address;
        readonly to: Address;
        readonly amount: bigint;
      }
    | {
        readonly kind: 'VerificationSet';
        readonly account: Address;
        readonly verified: boolean;
        readonly ref: Bytes32;
      }
    | {
        readonly kind: 'FrozenSet';
        readonly account: Address;
        readonly frozen: boolean;
        readonly ref: Bytes32;
      }
  );

/** The token events that settle an operation, keyed by the reference they carry. */
export type SettlementEvent = Extract<
  ObservedEvent,
  { kind: 'Minted' | 'Burned' | 'SettledTransfer' }
>;

/** The ledger's view of one operation. */
export interface LedgerOperationView {
  /** The operation id. */
  readonly id: string;
  /** Its on-chain reference. Unique across operations. */
  readonly ref: Bytes32;
  /** Its type; must match `parties.type`. */
  readonly type: OperationType;
  /** Its current status. */
  readonly status: OperationStatus;
  /** The amount in the token's smallest unit. */
  readonly amount: bigint;
  /** The on-chain addresses it touches. */
  readonly parties: OperationParties;
  /** The block its settling transaction was mined in, once confirmed; `null` otherwise. */
  readonly confirmedBlock: bigint | null;
}

/** Everything reconciliation compares: state as of `atBlock`, events up to `finalBlock`. */
export interface ReconciliationInput {
  /** The block balances, supply and flags are compared at. At most `finalBlock`. */
  readonly atBlock: bigint;
  /**
   * The newest FINAL block when the engine runs (`head - depth + 1`). Every confirmed operation's
   * `confirmedBlock` must be at or below it; events are considered up to it, so an operation
   * confirmed after `atBlock` still has to show its settling event.
   */
  readonly finalBlock: bigint;
  /** Every operation the ledger knows. */
  readonly operations: readonly LedgerOperationView[];
  /**
   * Every event from both contracts up to `finalBlock` (later ones are ignored). Engine obligation:
   * `canonicalBlockHashes` must hold the canonical hash of every block these events come from.
   */
  readonly events: readonly ObservedEvent[];
  /** Token balances read from the chain at `atBlock`. Should cover every expected address. */
  readonly observedBalances: ReadonlyMap<Address, bigint>;
  /** Total supply read from the chain at `atBlock`. */
  readonly observedSupply: bigint;
  /** Balances the ledger implies at `atBlock` (see `expectedChainState`). */
  readonly expectedBalances: ReadonlyMap<Address, bigint>;
  /** Supply the ledger implies at `atBlock`. Must equal the sum of `expectedBalances`. */
  readonly expectedSupply: bigint;
  /** Flags the bridge believes each address has at `atBlock`. */
  readonly expectedCompliance: ReadonlyMap<Address, ComplianceState>;
  /**
   * Flags read from the registry at `atBlock`. Engine obligation: read them for every address in
   * `expectedCompliance`, in any compliance event, and with a non-zero observed balance.
   */
  readonly observedCompliance: ReadonlyMap<Address, ComplianceState>;
  /**
   * Every compliance change the bridge made or is making, by its reference: what it writes. Every
   * `VerificationSet` / `FrozenSet` event must match its entry exactly.
   */
  readonly knownComplianceChanges: ReadonlyMap<Bytes32, ComplianceChangeContent>;
  /**
   * The canonical hash of every block that holds an event in `events`, from the node at the time of
   * the run. Engine obligation: read it from the chain, not from the indexer's own records; an
   * event whose block hash is missing here or differs is from an orphaned block (stale index).
   */
  readonly canonicalBlockHashes: ReadonlyMap<bigint, Hex>;
}

/** One disagreement between the ledger and the chain. */
export type Mismatch =
  | {
      readonly kind: 'missing_onchain';
      readonly operationId: string;
      readonly ref: Bytes32;
      readonly expectedEvent: SettlementEvent['kind'];
      readonly confirmedBlock: bigint;
    }
  | {
      /** The settling event exists but is in a different block than the ledger recorded. */
      readonly kind: 'confirmed_block_mismatch';
      readonly operationId: string;
      readonly ref: Bytes32;
      /** The operation's recorded `confirmedBlock`. */
      readonly expected: bigint;
      /** The block the settling event is actually in. */
      readonly observed: bigint;
      readonly txHash: TxHash;
      readonly logIndex: number;
    }
  | {
      readonly kind: 'amount_mismatch';
      readonly operationId: string;
      readonly ref: Bytes32;
      readonly expected: bigint;
      readonly observed: bigint;
      readonly txHash: TxHash;
      readonly logIndex: number;
      readonly blockNumber: bigint;
    }
  | {
      readonly kind: 'address_mismatch';
      readonly operationId: string;
      readonly ref: Bytes32;
      readonly field: 'from' | 'to';
      readonly expected: Address;
      readonly observed: Address;
      readonly txHash: TxHash;
      readonly logIndex: number;
      readonly blockNumber: bigint;
    }
  | {
      readonly kind: 'unexpected_onchain_event';
      readonly why:
        'unknown_reference' | 'operation_not_live' | 'duplicate' | 'wrong_kind' | 'stale_block';
      readonly event: ObservedEvent['kind'];
      /** `null` only for a stale `Transfer`, which carries no reference. */
      readonly ref: Bytes32 | null;
      readonly operationId: string | null;
      readonly operationStatus: OperationStatus | null;
      readonly txHash: TxHash;
      readonly logIndex: number;
      readonly blockNumber: bigint;
    }
  | {
      readonly kind: 'unexplained_transfer';
      readonly from: Address;
      readonly to: Address;
      readonly amount: bigint;
      readonly txHash: TxHash;
      readonly logIndex: number;
      readonly blockNumber: bigint;
    }
  | {
      readonly kind: 'balance_mismatch';
      readonly address: Address;
      readonly expected: bigint;
      /** `null` when the chain balance was not read: the ledger cannot vouch for it. */
      readonly observed: bigint | null;
    }
  | { readonly kind: 'supply_mismatch'; readonly expected: bigint; readonly observed: bigint }
  | {
      readonly kind: 'compliance_event_mismatch';
      /** No known change has this reference, or the event writes something else than the change. */
      readonly why: 'unknown_reference' | 'content_mismatch';
      readonly event: 'VerificationSet' | 'FrozenSet';
      readonly ref: Bytes32;
      /** The known change for the reference, or `null` when there is none. */
      readonly expected: ComplianceChangeContent | null;
      readonly observed: ComplianceChangeContent;
      readonly txHash: TxHash;
      readonly logIndex: number;
      readonly blockNumber: bigint;
    }
  | {
      readonly kind: 'compliance_mismatch';
      readonly address: Address;
      /** `null` when the bridge has no expectation for an address that needs one. */
      readonly expected: ComplianceState | null;
      /** `null` when the registry flags were not read. */
      readonly observed: ComplianceState | null;
    };

/** The full result of one reconciliation run. */
export interface ReconciliationReport {
  /** The block compared at. */
  readonly atBlock: bigint;
  /** Every mismatch, in a deterministic order. */
  readonly mismatches: readonly Mismatch[];
  /** True exactly when there are no mismatches. */
  readonly ok: boolean;
  /** Counts of things seen but deliberately not reported, so that nothing is silently hidden. */
  readonly summary: ReconciliationSummary;
}

/** What a run saw but did not report as a mismatch. */
export interface ReconciliationSummary {
  /**
   * ERC-20 `Transfer` events that move no balance: value 0, or `from === to`. Anyone can cause
   * these (a zero-value `transfer` call needs no balance), so reporting them would let an outsider
   * flood the report; counting them keeps them visible.
   */
  readonly ignoredNoiseTransfers: number;
}

/** The order mismatch kinds are listed in: per-operation findings first, then totals. */
const KIND_ORDER: readonly Mismatch['kind'][] = [
  'missing_onchain',
  'amount_mismatch',
  'address_mismatch',
  'confirmed_block_mismatch',
  'unexpected_onchain_event',
  'unexplained_transfer',
  'balance_mismatch',
  'supply_mismatch',
  'compliance_event_mismatch',
  'compliance_mismatch',
];

/** Statuses in which an operation may legitimately have its settling event on chain. */
const LIVE_STATUSES: ReadonlySet<OperationStatus> = new Set([
  'ledger_reserved',
  'submitted',
  'confirmed',
]);

function isSettlementEvent(e: ObservedEvent): e is SettlementEvent {
  return e.kind === 'Minted' || e.kind === 'Burned' || e.kind === 'SettledTransfer';
}

function compareChainOrder(a: ObservedEvent, b: ObservedEvent): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
  return a.logIndex - b.logIndex;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpBig(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A tuple that totally orders mismatches: kind, then a text key, then chain position. */
function sortKey(m: Mismatch): [number, string, bigint, number, string] {
  const rank = KIND_ORDER.indexOf(m.kind);
  switch (m.kind) {
    case 'missing_onchain':
      return [rank, m.operationId, 0n, 0, ''];
    case 'amount_mismatch':
      return [rank, m.operationId, m.blockNumber, m.logIndex, ''];
    case 'confirmed_block_mismatch':
      return [rank, m.operationId, m.observed, m.logIndex, ''];
    case 'address_mismatch':
      return [rank, m.operationId, m.blockNumber, m.logIndex, m.field];
    case 'unexpected_onchain_event':
      return [rank, m.ref ?? '', m.blockNumber, m.logIndex, m.why];
    case 'compliance_event_mismatch':
      return [rank, m.ref, m.blockNumber, m.logIndex, m.why];
    case 'unexplained_transfer':
      return [rank, '', m.blockNumber, m.logIndex, m.txHash];
    case 'balance_mismatch':
    case 'compliance_mismatch':
      return [rank, m.address, 0n, 0, ''];
    case 'supply_mismatch':
      return [rank, '', 0n, 0, ''];
  }
}

function compareMismatch(a: Mismatch, b: Mismatch): number {
  const ka = sortKey(a);
  const kb = sortKey(b);
  return (
    ka[0] - kb[0] ||
    cmpStr(ka[1], kb[1]) ||
    cmpBig(ka[2], kb[2]) ||
    ka[3] - kb[3] ||
    cmpStr(ka[4], kb[4])
  );
}

/**
 * Turns the differences between an event and its operation into mismatches. Shares
 * `settlementDifferences` with `resolveRevert`, so "matches" means the same thing in both places.
 * A kind difference becomes `unexpected_onchain_event` (`wrong_kind`), since the event is not this
 * operation's settlement at all.
 */
function differenceMismatches(
  op: LedgerOperationView,
  e: SettlementEvent,
  differences: readonly SettlementDifference[],
): Mismatch[] {
  const where = { txHash: e.txHash, logIndex: e.logIndex, blockNumber: e.blockNumber };
  return differences.map((d): Mismatch => {
    if (d.field === 'amount') {
      return {
        kind: 'amount_mismatch',
        operationId: op.id,
        ref: op.ref,
        expected: d.expected,
        observed: d.observed,
        ...where,
      };
    }
    if (d.field === 'from' || d.field === 'to') {
      return {
        kind: 'address_mismatch',
        operationId: op.id,
        ref: op.ref,
        field: d.field,
        expected: d.expected,
        observed: d.observed,
        ...where,
      };
    }
    // `kind` (or `ref`, which cannot differ here because events are looked up by reference): the
    // event is not this operation's settlement at all.
    return unexpected(e, 'wrong_kind', op);
  });
}

function unexpected(
  e: ObservedEvent,
  why: Extract<Mismatch, { kind: 'unexpected_onchain_event' }>['why'],
  op: LedgerOperationView | undefined,
): Mismatch {
  return {
    kind: 'unexpected_onchain_event',
    why,
    event: e.kind,
    ref: 'ref' in e ? e.ref : null,
    operationId: op?.id ?? null,
    operationStatus: op?.status ?? null,
    txHash: e.txHash,
    logIndex: e.logIndex,
    blockNumber: e.blockNumber,
  };
}

/** The (from, to, amount) movement a settlement event implies in an ERC-20 `Transfer` event. */
function impliedTransfer(e: SettlementEvent): { from: Address; to: Address; amount: bigint } {
  switch (e.kind) {
    case 'Minted':
      return { from: ZERO_ADDRESS, to: e.to, amount: e.amount };
    case 'Burned':
      return { from: e.from, to: ZERO_ADDRESS, amount: e.amount };
    case 'SettledTransfer':
      return { from: e.from, to: e.to, amount: e.amount };
  }
}

function validateInput(input: ReconciliationInput): Map<Bytes32, LedgerOperationView> {
  if (input.atBlock > input.finalBlock) {
    throw new InvalidInputError(
      `atBlock ${input.atBlock} is after finalBlock ${input.finalBlock}: compare only final state`,
    );
  }
  const byRef = new Map<Bytes32, LedgerOperationView>();
  for (const op of input.operations) {
    if (op.status === 'confirmed') {
      // A settlement must be in a block that is final now. A missing or future block would let a
      // confirmation the chain never made skip every check (review N-1).
      if (op.confirmedBlock === null || op.confirmedBlock > input.finalBlock) {
        throw new InvalidInputError(
          `confirmed operation ${op.id} has confirmedBlock ${String(op.confirmedBlock)}, ` +
            `not a final block (<= ${input.finalBlock})`,
        );
      }
    }
    if (op.type !== op.parties.type) {
      throw new InvalidInputError(
        `operation ${op.id} has type ${op.type} but ${op.parties.type} parties`,
      );
    }
    if (byRef.has(op.ref)) {
      throw new InvalidInputError(`two operations share reference ${op.ref}`);
    }
    byRef.set(op.ref, op);
  }
  for (const [ref, change] of input.knownComplianceChanges) {
    if (change.ref !== ref) {
      throw new InvalidInputError(
        `known compliance change keyed ${ref} carries reference ${change.ref}`,
      );
    }
  }
  let sum = 0n;
  for (const [address, amount] of input.expectedBalances) {
    if (amount < 0n) {
      throw new InvalidInputError(`expected balance of ${address} is negative (${amount})`);
    }
    sum += amount;
  }
  if (sum !== input.expectedSupply) {
    // The two expectations come from one ledger; if they disagree, the ledger view is broken and
    // any comparison with the chain would be meaningless.
    throw new InvalidInputError(
      `expectedSupply ${input.expectedSupply} is not the sum of expectedBalances (${sum})`,
    );
  }
  return byRef;
}

/**
 * Compares the ledger with the chain at `input.atBlock`. Returns every mismatch in a fixed order;
 * `ok` is true exactly when there are none. Throws `InvalidInputError` when the ledger view is
 * itself inconsistent (two operations with one reference, a type that contradicts its parties,
 * an `expectedSupply` that is not the sum of `expectedBalances`, a negative expected balance).
 *
 * Events from a block whose hash is not the canonical one (or is unknown) are reported as
 * `stale_block` and otherwise ignored: they never satisfy a `missing_onchain`, never explain a
 * Transfer and are never checked as compliance changes. Every registry event must match a known
 * change exactly. Compliance flags are checked for every address that is expected, appears in a
 * (canonical) compliance event, or holds a non-zero observed balance.
 *
 * Two blocks matter. Balances, supply and flags are compared at `atBlock`. Events are considered up
 * to `finalBlock`: every confirmed operation must have a final `confirmedBlock` (else
 * `InvalidInputError`), and must show its canonical settling event IN that block, whether it is
 * before or after `atBlock` (else `missing_onchain` or `confirmed_block_mismatch`). Operations
 * confirmed in (`atBlock`, `finalBlock`] are left out of the expected balances at `atBlock`
 * (see `expectedChainState`) but never out of the event check, so a forged future block cannot
 * hide a settlement the chain never made. Operations still in flight (`ledger_reserved`,
 * `submitted`) are never reported missing. An expected address whose chain balance or registry
 * flags were not read is reported with `observed: null` rather than assumed correct.
 *
 * What it does NOT check: that every settlement event has its matching ERC-20 `Transfer` (only the
 * reverse direction, every Transfer explained by a settlement event, is checked). The balance and
 * supply comparisons catch the money effect of that gap, but not its cause.
 */
export function reconcile(input: ReconciliationInput): ReconciliationReport {
  const byRef = validateInput(input);
  const mismatches: Mismatch[] = [];
  // 0. Only events at or before finalBlock, and only from canonical blocks.
  const events: ObservedEvent[] = [];
  for (const e of input.events) {
    if (e.blockNumber > input.finalBlock) continue;
    if (input.canonicalBlockHashes.get(e.blockNumber) !== e.blockHash) {
      mismatches.push(unexpected(e, 'stale_block', 'ref' in e ? byRef.get(e.ref) : undefined));
      continue;
    }
    events.push(e);
  }
  events.sort(compareChainOrder);

  // 1. Reference events against the operations (or compliance changes) they name.
  const settledByRef = new Map<Bytes32, SettlementEvent>();
  const complianceAccounts = new Set<Address>();
  for (const e of events) {
    if (e.kind === 'VerificationSet' || e.kind === 'FrozenSet') {
      complianceAccounts.add(e.account);
      const known = input.knownComplianceChanges.get(e.ref);
      if (known === undefined || !complianceEventMatches(known, e)) {
        mismatches.push({
          kind: 'compliance_event_mismatch',
          why: known === undefined ? 'unknown_reference' : 'content_mismatch',
          event: e.kind,
          ref: e.ref,
          expected: known ?? null,
          observed: complianceEventContent(e),
          txHash: e.txHash,
          logIndex: e.logIndex,
          blockNumber: e.blockNumber,
        });
      }
      continue;
    }
    if (!isSettlementEvent(e)) continue;
    const op = byRef.get(e.ref);
    if (op === undefined) {
      mismatches.push(unexpected(e, 'unknown_reference', undefined));
      continue;
    }
    const differences = settlementDifferences(op, e);
    if (differences.some((d) => d.field === 'kind')) {
      mismatches.push(...differenceMismatches(op, e, differences));
      continue;
    }
    if (!LIVE_STATUSES.has(op.status)) {
      // Failed, reversed, or never reserved: the ledger released (or never locked) these funds.
      mismatches.push(unexpected(e, 'operation_not_live', op));
      continue;
    }
    if (settledByRef.has(e.ref)) {
      mismatches.push(unexpected(e, 'duplicate', op));
      continue;
    }
    settledByRef.set(e.ref, e);
    mismatches.push(...differenceMismatches(op, e, differences));
  }

  // 2. Every confirmed operation must show its settling event, in its recorded block.
  for (const op of input.operations) {
    if (op.status !== 'confirmed') continue;
    const confirmedBlock = op.confirmedBlock as bigint; // validated above
    const event = settledByRef.get(op.ref);
    if (event === undefined) {
      mismatches.push({
        kind: 'missing_onchain',
        operationId: op.id,
        ref: op.ref,
        expectedEvent: SETTLING_EVENT[op.type],
        confirmedBlock,
      });
    } else if (event.blockNumber !== confirmedBlock) {
      mismatches.push({
        kind: 'confirmed_block_mismatch',
        operationId: op.id,
        ref: op.ref,
        expected: confirmedBlock,
        observed: event.blockNumber,
        txHash: event.txHash,
        logIndex: event.logIndex,
      });
    }
  }

  // 3. Every ERC-20 Transfer must be explained by a settlement event in the same transaction.
  //    Each settlement event explains at most one Transfer.
  const unusedByTx = new Map<TxHash, SettlementEvent[]>();
  for (const e of events) {
    if (!isSettlementEvent(e)) continue;
    const list = unusedByTx.get(e.txHash) ?? [];
    list.push(e);
    unusedByTx.set(e.txHash, list);
  }
  let ignoredNoiseTransfers = 0;
  for (const e of events) {
    if (e.kind !== 'Transfer') continue;
    if (e.amount === 0n || e.from === e.to) {
      // Moves no balance and needs no privilege to emit: counted, not reported.
      ignoredNoiseTransfers += 1;
      continue;
    }
    const candidates = unusedByTx.get(e.txHash) ?? [];
    const idx = candidates.findIndex((c) => {
      const t = impliedTransfer(c);
      return t.from === e.from && t.to === e.to && t.amount === e.amount;
    });
    if (idx >= 0) {
      candidates.splice(idx, 1);
    } else {
      mismatches.push({
        kind: 'unexplained_transfer',
        from: e.from,
        to: e.to,
        amount: e.amount,
        txHash: e.txHash,
        logIndex: e.logIndex,
        blockNumber: e.blockNumber,
      });
    }
  }

  // 4. Balances, over every address either side mentions. A missing expectation means the ledger
  //    claims nothing there (0); a missing observation means it was not read (cannot vouch).
  const addresses = new Set<Address>([
    ...input.expectedBalances.keys(),
    ...input.observedBalances.keys(),
  ]);
  for (const address of addresses) {
    const expected = input.expectedBalances.get(address) ?? 0n;
    const observed = input.observedBalances.get(address);
    if (observed === undefined || observed !== expected) {
      mismatches.push({ kind: 'balance_mismatch', address, expected, observed: observed ?? null });
    }
  }

  // 5. Supply.
  if (input.expectedSupply !== input.observedSupply) {
    mismatches.push({
      kind: 'supply_mismatch',
      expected: input.expectedSupply,
      observed: input.observedSupply,
    });
  }

  // 6. Compliance flags for every address that needs them: expected ones, those a compliance
  //    event touched, and every holder. A holder the bridge has no expectation for is a finding.
  const flagAddresses = new Set<Address>([
    ...input.expectedCompliance.keys(),
    ...complianceAccounts,
  ]);
  for (const [address, amount] of input.observedBalances) {
    if (amount !== 0n) flagAddresses.add(address);
  }
  for (const address of flagAddresses) {
    const expected = input.expectedCompliance.get(address) ?? null;
    const observed = input.observedCompliance.get(address) ?? null;
    if (
      expected === null ||
      observed === null ||
      observed.verified !== expected.verified ||
      observed.frozen !== expected.frozen
    ) {
      mismatches.push({ kind: 'compliance_mismatch', address, expected, observed });
    }
  }

  mismatches.sort(compareMismatch);
  return {
    atBlock: input.atBlock,
    mismatches,
    ok: mismatches.length === 0,
    summary: { ignoredNoiseTransfers },
  };
}
