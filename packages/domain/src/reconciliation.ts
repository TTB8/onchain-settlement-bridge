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
 *   an operation that failed or was reversed, a second event for one reference, the wrong kind).
 * - `unexplained_transfer`: tokens moved without one of our reference events in the same
 *   transaction. The contract should make this impossible; seeing one means a key or the contract
 *   is compromised.
 * - `balance_mismatch` / `supply_mismatch`: the totals disagree, whatever the cause.
 * - `compliance_mismatch`: the registry's flags differ from what the bridge believes.
 *
 * The function is pure and its output order is fixed (independent of input order), so two runs on
 * the same data produce byte-identical reports that can be diffed and stored.
 */

import type { ComplianceState } from './compliance';
import { InvalidInputError } from './errors';
import {
  type OperationParties,
  type OperationStatus,
  type OperationType,
  type SettlementDifference,
  SETTLING_EVENT,
  settlementDifferences,
} from './operation';
import { type Address, type Bytes32, type TxHash, ZERO_ADDRESS } from './primitives';

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

/** Everything reconciliation compares, all as of `atBlock`. */
export interface ReconciliationInput {
  /** The block the comparison is made at. Events after it are ignored. */
  readonly atBlock: bigint;
  /** Every operation the ledger knows. */
  readonly operations: readonly LedgerOperationView[];
  /** Every event from both contracts up to `atBlock` (later ones are ignored). */
  readonly events: readonly ObservedEvent[];
  /** Token balances read from the chain at `atBlock`. Should cover every expected address. */
  readonly observedBalances: ReadonlyMap<Address, bigint>;
  /** Total supply read from the chain at `atBlock`. */
  readonly observedSupply: bigint;
  /** Balances the ledger implies from settled operations. */
  readonly expectedBalances: ReadonlyMap<Address, bigint>;
  /** Supply the ledger implies from settled operations. */
  readonly expectedSupply: bigint;
  /** Flags the bridge believes each address has, when compliance is being checked. */
  readonly expectedCompliance?: ReadonlyMap<Address, ComplianceState>;
  /** Flags read from the registry at `atBlock`, for the addresses in `expectedCompliance`. */
  readonly observedCompliance?: ReadonlyMap<Address, ComplianceState>;
  /**
   * References of compliance changes the bridge sent. When given, a VerificationSet or FrozenSet
   * whose reference is not in it is reported as unexpected (a change the bridge did not make).
   */
  readonly knownComplianceRefs?: ReadonlySet<Bytes32>;
}

/** One disagreement between the ledger and the chain. */
export type Mismatch =
  | {
      readonly kind: 'missing_onchain';
      readonly operationId: string;
      readonly ref: Bytes32;
      readonly expectedEvent: SettlementEvent['kind'];
      readonly confirmedBlock: bigint | null;
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
      readonly why: 'unknown_reference' | 'operation_not_live' | 'duplicate' | 'wrong_kind';
      readonly event: ObservedEvent['kind'];
      readonly ref: Bytes32;
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
      readonly kind: 'compliance_mismatch';
      readonly address: Address;
      readonly expected: ComplianceState;
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
  'unexpected_onchain_event',
  'unexplained_transfer',
  'balance_mismatch',
  'supply_mismatch',
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
    case 'address_mismatch':
      return [rank, m.operationId, m.blockNumber, m.logIndex, m.field];
    case 'unexpected_onchain_event':
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
    switch (d.field) {
      case 'kind':
        return unexpected(e, 'wrong_kind', op);
      case 'amount':
        return {
          kind: 'amount_mismatch',
          operationId: op.id,
          ref: op.ref,
          expected: d.expected,
          observed: d.observed,
          ...where,
        };
      default:
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
  });
}

function unexpected(
  e: ObservedEvent & { ref: Bytes32 },
  why: Extract<Mismatch, { kind: 'unexpected_onchain_event' }>['why'],
  op: LedgerOperationView | undefined,
): Mismatch {
  return {
    kind: 'unexpected_onchain_event',
    why,
    event: e.kind,
    ref: e.ref,
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
  const byRef = new Map<Bytes32, LedgerOperationView>();
  for (const op of input.operations) {
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
  return byRef;
}

/**
 * Compares the ledger with the chain at `input.atBlock`. Returns every mismatch in a fixed order;
 * `ok` is true exactly when there are none. Throws `InvalidInputError` when the ledger view is
 * itself inconsistent (two operations with one reference, a type that contradicts its parties).
 *
 * Operations still in flight (`ledger_reserved`, `submitted`) and confirmed after `atBlock` are
 * never reported missing: the chain is not expected to show them yet. A confirmed operation with no
 * recorded block is treated as due (fail closed: the ledger claims it settled).
 */
export function reconcile(input: ReconciliationInput): ReconciliationReport {
  const byRef = validateInput(input);
  const mismatches: Mismatch[] = [];
  const events = input.events.filter((e) => e.blockNumber <= input.atBlock).sort(compareChainOrder);

  // 1. Reference events against the operations they name.
  const settledByRef = new Map<Bytes32, SettlementEvent>();
  for (const e of events) {
    if (e.kind === 'VerificationSet' || e.kind === 'FrozenSet') {
      if (input.knownComplianceRefs !== undefined && !input.knownComplianceRefs.has(e.ref)) {
        mismatches.push(unexpected(e, 'unknown_reference', undefined));
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

  // 2. Settled operations that the chain should show by now.
  for (const op of input.operations) {
    if (op.status !== 'confirmed') continue;
    if (op.confirmedBlock !== null && op.confirmedBlock > input.atBlock) continue;
    if (!settledByRef.has(op.ref)) {
      mismatches.push({
        kind: 'missing_onchain',
        operationId: op.id,
        ref: op.ref,
        expectedEvent: SETTLING_EVENT[op.type],
        confirmedBlock: op.confirmedBlock,
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

  // 6. Compliance flags, when the caller supplies expectations.
  for (const [address, expected] of input.expectedCompliance ??
    new Map<Address, ComplianceState>()) {
    const observed = input.observedCompliance?.get(address);
    if (
      observed === undefined ||
      observed.verified !== expected.verified ||
      observed.frozen !== expected.frozen
    ) {
      mismatches.push({
        kind: 'compliance_mismatch',
        address,
        expected,
        observed: observed ?? null,
      });
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
