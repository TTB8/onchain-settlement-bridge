import {
  type Address,
  type ComplianceState,
  InvalidInputError,
  type LedgerOperationView,
  type ObservedEvent,
  reconcile,
  type ReconciliationInput,
  ZERO_ADDRESS,
} from '../src';
import { addr, bh, prng, randInt, refOf, txh } from './support/fixtures';

const alice = addr(0xa);
const bob = addr(0xb);
const mallory = addr(0xee);
const PARTIES = [alice, bob, mallory];
/** The canonical hash of blocks 0..40 is `bh('b<n>')`, which is what `pos` stamps on events. */
const CANONICAL = new Map<bigint, `0x${string}`>(
  Array.from({ length: 41 }, (_, n) => [BigInt(n), bh(`b${n}`)]),
);

const pos = (block: number, tx: number, logIndex: number) => ({
  blockNumber: BigInt(block),
  blockHash: bh(`b${block}`),
  txHash: txh(tx),
  logIndex,
});

/** A clean world: a deposit to alice (100), a transfer alice->bob (30), a withdrawal by bob (10). */
function cleanWorld(): ReconciliationInput {
  const operations: LedgerOperationView[] = [
    {
      id: 'op-dep',
      ref: refOf(1),
      type: 'deposit',
      status: 'confirmed',
      amount: 100n,
      parties: { type: 'deposit', to: alice },
      confirmedBlock: 10n,
    },
    {
      id: 'op-tr',
      ref: refOf(2),
      type: 'transfer',
      status: 'confirmed',
      amount: 30n,
      parties: { type: 'transfer', from: alice, to: bob },
      confirmedBlock: 11n,
    },
    {
      id: 'op-wd',
      ref: refOf(3),
      type: 'withdrawal',
      status: 'confirmed',
      amount: 10n,
      parties: { type: 'withdrawal', from: bob },
      confirmedBlock: 12n,
    },
  ];
  const events: ObservedEvent[] = [
    { ...pos(10, 1, 0), kind: 'Transfer', from: ZERO_ADDRESS, to: alice, amount: 100n },
    { ...pos(10, 1, 1), kind: 'Minted', to: alice, amount: 100n, ref: refOf(1) },
    { ...pos(11, 2, 0), kind: 'Transfer', from: alice, to: bob, amount: 30n },
    { ...pos(11, 2, 1), kind: 'SettledTransfer', from: alice, to: bob, amount: 30n, ref: refOf(2) },
    { ...pos(12, 3, 0), kind: 'Transfer', from: bob, to: ZERO_ADDRESS, amount: 10n },
    { ...pos(12, 3, 1), kind: 'Burned', from: bob, amount: 10n, ref: refOf(3) },
  ];
  const balances = new Map<Address, bigint>([
    [alice, 70n],
    [bob, 20n],
  ]);
  return {
    atBlock: 20n,
    operations,
    events,
    observedBalances: balances,
    observedSupply: 90n,
    expectedBalances: new Map(balances),
    expectedSupply: 90n,
    // Every party (and the would-be attacker) has known, matching registry flags.
    expectedCompliance: new Map(PARTIES.map((a) => [a, OK])),
    observedCompliance: new Map(PARTIES.map((a) => [a, OK])),
    knownComplianceChanges: new Map(),
    canonicalBlockHashes: CANONICAL,
  };
}

const OK: ComplianceState = { verified: true, frozen: false };

function kinds(input: ReconciliationInput): string[] {
  return reconcile(input).mismatches.map((m) => m.kind);
}

describe('reconcile', () => {
  it('reports ok with zero mismatches for a clean run', () => {
    const r = reconcile(cleanWorld());
    expect(r).toEqual({
      atBlock: 20n,
      mismatches: [],
      ok: true,
      summary: { ignoredNoiseTransfers: 0 },
    });
  });

  it('ignores events after atBlock', () => {
    const w = cleanWorld();
    const r = reconcile({
      ...w,
      events: [
        ...w.events,
        { ...pos(21, 9, 0), kind: 'Transfer', from: alice, to: mallory, amount: 1n },
      ],
    });
    expect(r.ok).toBe(true);
  });

  describe('missing_onchain', () => {
    it('reports a confirmed operation with no event', () => {
      const w = cleanWorld();
      const r = reconcile({
        ...w,
        events: w.events.filter((e) => e.kind !== 'Burned' && e.txHash !== txh(3)),
        observedBalances: new Map([
          [alice, 70n],
          [bob, 20n],
        ]),
      });
      expect(r.mismatches).toEqual([
        {
          kind: 'missing_onchain',
          operationId: 'op-wd',
          ref: refOf(3),
          expectedEvent: 'Burned',
          confirmedBlock: 12n,
        },
      ]);
      expect(r.ok).toBe(false);
    });

    it('does not report in-flight operations or ones confirmed after atBlock', () => {
      const w = cleanWorld();
      const extra: LedgerOperationView[] = [
        {
          id: 'op-r',
          ref: refOf(10),
          type: 'deposit',
          status: 'ledger_reserved',
          amount: 5n,
          parties: { type: 'deposit', to: alice },
          confirmedBlock: null,
        },
        {
          id: 'op-s',
          ref: refOf(11),
          type: 'deposit',
          status: 'submitted',
          amount: 5n,
          parties: { type: 'deposit', to: alice },
          confirmedBlock: null,
        },
        {
          id: 'op-late',
          ref: refOf(12),
          type: 'deposit',
          status: 'confirmed',
          amount: 5n,
          parties: { type: 'deposit', to: alice },
          confirmedBlock: 21n,
        },
        {
          id: 'op-f',
          ref: refOf(13),
          type: 'deposit',
          status: 'failed',
          amount: 5n,
          parties: { type: 'deposit', to: alice },
          confirmedBlock: null,
        },
        {
          id: 'op-q',
          ref: refOf(14),
          type: 'deposit',
          status: 'requested',
          amount: 5n,
          parties: { type: 'deposit', to: alice },
          confirmedBlock: null,
        },
      ];
      expect(reconcile({ ...w, operations: [...w.operations, ...extra] }).ok).toBe(true);
    });

    it('treats a confirmed operation without a recorded block as due (fail closed)', () => {
      const w = cleanWorld();
      const op: LedgerOperationView = {
        id: 'op-nb',
        ref: refOf(20),
        type: 'deposit',
        status: 'confirmed',
        amount: 5n,
        parties: { type: 'deposit', to: alice },
        confirmedBlock: null,
      };
      expect(kinds({ ...w, operations: [...w.operations, op] })).toEqual(['missing_onchain']);
    });
  });

  it('reports amount_mismatch with both amounts and the event position', () => {
    const w = cleanWorld();
    const events = w.events.map((e) =>
      e.kind === 'Minted'
        ? { ...e, amount: 99n }
        : e.kind === 'Transfer' && e.txHash === txh(1)
          ? { ...e, amount: 99n }
          : e,
    );
    expect(reconcile({ ...w, events }).mismatches).toEqual([
      {
        kind: 'amount_mismatch',
        operationId: 'op-dep',
        ref: refOf(1),
        expected: 100n,
        observed: 99n,
        txHash: txh(1),
        logIndex: 1,
        blockNumber: 10n,
      },
    ]);
  });

  it('reports address_mismatch per wrong field', () => {
    const w = cleanWorld();
    const events = w.events.map((e) => {
      if (e.kind === 'SettledTransfer') return { ...e, to: mallory };
      if (e.kind === 'Transfer' && e.txHash === txh(2)) return { ...e, to: mallory };
      return e;
    });
    const r = reconcile({ ...w, events });
    expect(r.mismatches).toEqual([
      {
        kind: 'address_mismatch',
        operationId: 'op-tr',
        ref: refOf(2),
        field: 'to',
        expected: bob,
        observed: mallory,
        txHash: txh(2),
        logIndex: 1,
        blockNumber: 11n,
      },
    ]);
  });

  describe('unexpected_onchain_event', () => {
    it('reports a reference event whose reference the ledger does not know', () => {
      const w = cleanWorld();
      const r = reconcile({
        ...w,
        events: [
          ...w.events,
          { ...pos(13, 4, 0), kind: 'Transfer', from: ZERO_ADDRESS, to: mallory, amount: 5n },
          { ...pos(13, 4, 1), kind: 'Minted', to: mallory, amount: 5n, ref: refOf(99) },
        ],
        observedBalances: new Map([...w.observedBalances, [mallory, 5n]]),
        observedSupply: 95n,
      });
      expect(r.mismatches.map((m) => m.kind)).toEqual([
        'unexpected_onchain_event',
        'balance_mismatch',
        'supply_mismatch',
      ]);
      expect(r.mismatches[0]).toMatchObject({
        why: 'unknown_reference',
        event: 'Minted',
        ref: refOf(99),
        operationId: null,
        operationStatus: null,
      });
    });

    it('reports an event for a failed or reversed operation', () => {
      const w = cleanWorld();
      for (const status of ['failed', 'reversed', 'requested'] as const) {
        const operations = w.operations.map((o) =>
          o.id === 'op-wd' ? { ...o, status, confirmedBlock: null } : o,
        );
        const r = reconcile({ ...w, operations });
        expect(r.mismatches).toHaveLength(1);
        expect(r.mismatches[0]).toMatchObject({
          kind: 'unexpected_onchain_event',
          why: 'operation_not_live',
          operationId: 'op-wd',
          operationStatus: status,
        });
      }
    });

    it('accepts the settling event of an in-flight operation (mined, not yet deep)', () => {
      const w = cleanWorld();
      const operations = w.operations.map((o) =>
        o.id === 'op-wd' ? { ...o, status: 'submitted' as const, confirmedBlock: null } : o,
      );
      expect(reconcile({ ...w, operations }).ok).toBe(true);
    });

    it('reports a duplicate event for one reference, and does not double count it', () => {
      const w = cleanWorld();
      const r = reconcile({
        ...w,
        events: [
          ...w.events,
          { ...pos(14, 5, 0), kind: 'Transfer', from: ZERO_ADDRESS, to: alice, amount: 100n },
          { ...pos(14, 5, 1), kind: 'Minted', to: alice, amount: 100n, ref: refOf(1) },
        ],
      });
      expect(r.mismatches).toEqual([
        expect.objectContaining({
          kind: 'unexpected_onchain_event',
          why: 'duplicate',
          ref: refOf(1),
          operationId: 'op-dep',
          blockNumber: 14n,
          logIndex: 1,
        }),
      ]);
    });

    it('reports the wrong kind of event for an operation', () => {
      const w = cleanWorld();
      const r = reconcile({
        ...w,
        events: [
          ...w.events.filter((e) => e.txHash !== txh(3)),
          { ...pos(12, 3, 0), kind: 'Transfer', from: ZERO_ADDRESS, to: bob, amount: 10n },
          { ...pos(12, 3, 1), kind: 'Minted', to: bob, amount: 10n, ref: refOf(3) },
        ],
      });
      expect(r.mismatches.map((m) => [m.kind, 'why' in m ? m.why : null])).toEqual([
        ['missing_onchain', null],
        ['unexpected_onchain_event', 'wrong_kind'],
      ]);
    });

    it('reports a stale event (orphaned block) and never lets it satisfy missing_onchain (L-3)', () => {
      // The indexer still holds the Minted from a block that was reorged away: same height, other hash.
      const w = cleanWorld();
      const events = w.events.map((e) =>
        e.txHash === txh(1) ? { ...e, blockHash: bh('orphan10') } : e,
      );
      const r = reconcile({ ...w, events });
      expect(r.mismatches).toEqual([
        expect.objectContaining({ kind: 'missing_onchain', operationId: 'op-dep' }),
        expect.objectContaining({
          kind: 'unexpected_onchain_event',
          why: 'stale_block',
          event: 'Transfer',
          ref: null,
          operationId: null,
          logIndex: 0,
        }),
        expect.objectContaining({
          kind: 'unexpected_onchain_event',
          why: 'stale_block',
          event: 'Minted',
          ref: refOf(1),
          operationId: 'op-dep',
          logIndex: 1,
        }),
      ]);
    });

    it('treats an event whose block has no canonical hash as stale (fail closed)', () => {
      const w = cleanWorld();
      const canonical = new Map(w.canonicalBlockHashes);
      canonical.delete(12n);
      const r = reconcile({ ...w, canonicalBlockHashes: canonical });
      expect(r.mismatches.map((m) => [m.kind, 'why' in m ? m.why : null])).toEqual([
        ['missing_onchain', null],
        ['unexpected_onchain_event', 'stale_block'],
        ['unexpected_onchain_event', 'stale_block'],
      ]);
    });
  });

  describe('compliance events (M-3)', () => {
    const change = (account: Address, flag: 'verified' | 'frozen', value: boolean) => ({
      account,
      flag,
      value,
    });

    it('accepts registry events that match their known changes exactly', () => {
      const w = cleanWorld();
      const r = reconcile({
        ...w,
        events: [
          ...w.events,
          {
            ...pos(15, 6, 0),
            kind: 'VerificationSet',
            account: bob,
            verified: true,
            ref: refOf(51),
          },
        ],
        knownComplianceChanges: new Map([[refOf(51), change(bob, 'verified', true)]]),
      });
      expect(r.ok).toBe(true);
    });

    it('a rogue setVerified with no known changes gives ok:false', () => {
      const w = cleanWorld();
      const r = reconcile({
        ...w,
        events: [
          ...w.events,
          {
            ...pos(15, 6, 0),
            kind: 'VerificationSet',
            account: mallory,
            verified: true,
            ref: refOf(66),
          },
        ],
      });
      expect(r.ok).toBe(false);
      expect(r.mismatches).toEqual([
        {
          kind: 'compliance_event_mismatch',
          why: 'unknown_reference',
          event: 'VerificationSet',
          ref: refOf(66),
          expected: null,
          observed: change(mallory, 'verified', true),
          txHash: txh(6),
          logIndex: 0,
          blockNumber: 15n,
        },
      ]);
    });

    it('reports the front-run case: a known reference used for another account', () => {
      const w = cleanWorld();
      const r = reconcile({
        ...w,
        events: [
          ...w.events,
          { ...pos(15, 6, 0), kind: 'FrozenSet', account: alice, frozen: true, ref: refOf(52) },
        ],
        knownComplianceChanges: new Map([[refOf(52), change(mallory, 'frozen', true)]]),
      });
      expect(r.mismatches).toEqual([
        expect.objectContaining({
          kind: 'compliance_event_mismatch',
          why: 'content_mismatch',
          expected: change(mallory, 'frozen', true),
          observed: change(alice, 'frozen', true),
        }),
      ]);
    });

    it('reports a known reference whose event writes another flag or value', () => {
      const w = cleanWorld();
      const known = new Map([[refOf(53), change(bob, 'frozen', true)]]);
      for (const ev of [
        { kind: 'FrozenSet', account: bob, frozen: false, ref: refOf(53) },
        { kind: 'VerificationSet', account: bob, verified: true, ref: refOf(53) },
      ] as const) {
        const r = reconcile({
          ...w,
          events: [...w.events, { ...pos(15, 6, 0), ...ev }],
          knownComplianceChanges: known,
        });
        expect(r.mismatches.map((m) => ('why' in m ? m.why : m.kind))).toEqual([
          'content_mismatch',
        ]);
      }
    });
  });

  describe('unexplained_transfer', () => {
    it('reports a rogue transfer with no reference event in the same transaction', () => {
      const w = cleanWorld();
      const r = reconcile({
        ...w,
        events: [
          ...w.events,
          { ...pos(16, 8, 0), kind: 'Transfer', from: bob, to: mallory, amount: 20n },
        ],
        observedBalances: new Map([
          [alice, 70n],
          [bob, 0n],
          [mallory, 20n],
        ]),
      });
      expect(r.mismatches).toEqual([
        {
          kind: 'unexplained_transfer',
          from: bob,
          to: mallory,
          amount: 20n,
          txHash: txh(8),
          logIndex: 0,
          blockNumber: 16n,
        },
        { kind: 'balance_mismatch', address: bob, expected: 20n, observed: 0n },
        { kind: 'balance_mismatch', address: mallory, expected: 0n, observed: 20n },
      ]);
    });

    it('does not let a reference event in another transaction explain a transfer', () => {
      const w = cleanWorld();
      const events = w.events.map((e) =>
        e.kind === 'Transfer' && e.txHash === txh(2) ? { ...e, txHash: txh(77) } : e,
      );
      expect(kinds({ ...w, events })).toEqual(['unexplained_transfer']);
    });

    it('lets one reference event explain only one transfer', () => {
      const w = cleanWorld();
      const r = reconcile({
        ...w,
        events: [
          ...w.events,
          { ...pos(11, 2, 2), kind: 'Transfer', from: alice, to: bob, amount: 30n },
        ],
      });
      expect(r.mismatches).toEqual([
        expect.objectContaining({ kind: 'unexplained_transfer', logIndex: 2 }),
      ]);
    });

    it('needs a matching mint/burn shape: a Minted does not explain a transfer between holders', () => {
      const w = cleanWorld();
      const events = w.events.map((e) =>
        e.kind === 'Transfer' && e.txHash === txh(1) ? { ...e, from: bob } : e,
      );
      expect(kinds({ ...w, events })).toEqual(['unexplained_transfer']);
    });

    it('needs the amount to match: a mint that moves more than its Minted event claims is unexplained', () => {
      const w = cleanWorld();
      const events = w.events.map((e) =>
        e.kind === 'Transfer' && e.txHash === txh(1) ? { ...e, amount: 1_000n } : e,
      );
      const r = reconcile({
        ...w,
        events,
        observedBalances: new Map([...w.observedBalances, [alice, 970n]]),
        observedSupply: 990n,
      });
      expect(r.mismatches).toEqual([
        {
          kind: 'unexplained_transfer',
          from: ZERO_ADDRESS,
          to: alice,
          amount: 1_000n,
          txHash: txh(1),
          logIndex: 0,
          blockNumber: 10n,
        },
        { kind: 'balance_mismatch', address: alice, expected: 70n, observed: 970n },
        { kind: 'supply_mismatch', expected: 90n, observed: 990n },
      ]);
    });

    describe('each field of the transfer match is checked on its own (L-7)', () => {
      const carol = addr(0xc);
      /** The clean world with the withdrawal's burn Transfer (tx 3) replaced by `transfer`. */
      const withBurnTransfer = (from: Address, to: Address, amount: bigint) => {
        const w = cleanWorld();
        return kinds({
          ...w,
          events: w.events.map((e) =>
            e.kind === 'Transfer' && e.txHash === txh(3) ? { ...e, from, to, amount } : e,
          ),
        });
      };

      it('Burned(bob, 10) explains exactly Transfer(bob -> 0x0, 10)', () => {
        expect(withBurnTransfer(bob, ZERO_ADDRESS, 10n)).toEqual([]);
      });

      it('Burned(bob, 10) does NOT explain Transfer(bob -> carol, 10): `to` differs', () => {
        expect(withBurnTransfer(bob, carol, 10n)).toEqual(['unexplained_transfer']);
      });

      it('Burned(bob, 10) does NOT explain Transfer(carol -> 0x0, 10): `from` differs', () => {
        expect(withBurnTransfer(carol, ZERO_ADDRESS, 10n)).toEqual(['unexplained_transfer']);
      });

      it('Burned(bob, 10) does NOT explain Transfer(bob -> 0x0, 9): `amount` differs', () => {
        expect(withBurnTransfer(bob, ZERO_ADDRESS, 9n)).toEqual(['unexplained_transfer']);
      });

      it('SettledTransfer(alice -> bob) does NOT explain Transfer(alice -> carol) nor (carol -> bob)', () => {
        const w = cleanWorld();
        for (const patch of [{ to: carol }, { from: carol }]) {
          const events = w.events.map((e) =>
            e.kind === 'Transfer' && e.txHash === txh(2) ? { ...e, ...patch } : e,
          );
          expect(kinds({ ...w, events })).toEqual(['unexplained_transfer']);
        }
      });

      it('Minted(alice) does NOT explain Transfer(0x0 -> carol)', () => {
        const w = cleanWorld();
        const events = w.events.map((e) =>
          e.kind === 'Transfer' && e.txHash === txh(1) ? { ...e, to: carol } : e,
        );
        expect(kinds({ ...w, events })).toEqual(['unexplained_transfer']);
      });
    });

    it('includes an event exactly at atBlock and excludes one at atBlock + 1 (L-7)', () => {
      const w = cleanWorld();
      const rogue = (block: number): ObservedEvent => ({
        ...pos(block, 40, 0),
        kind: 'Transfer',
        from: alice,
        to: bob,
        amount: 1n,
      });
      expect(kinds({ ...w, events: [...w.events, rogue(20)] })).toEqual(['unexplained_transfer']);
      expect(kinds({ ...w, events: [...w.events, rogue(21)] })).toEqual([]);
    });

    it('counts zero-value and self transfers as noise instead of reporting them', () => {
      const w = cleanWorld();
      const r = reconcile({
        ...w,
        events: [
          ...w.events,
          { ...pos(17, 9, 0), kind: 'Transfer', from: mallory, to: alice, amount: 0n },
          { ...pos(17, 9, 1), kind: 'Transfer', from: bob, to: bob, amount: 5n },
          { ...pos(17, 10, 0), kind: 'Transfer', from: mallory, to: alice, amount: 1n },
        ],
        observedBalances: new Map([...w.observedBalances, [alice, 71n]]),
      });
      expect(r.summary.ignoredNoiseTransfers).toBe(2);
      expect(r.mismatches).toEqual([
        expect.objectContaining({
          kind: 'unexplained_transfer',
          from: mallory,
          to: alice,
          amount: 1n,
        }),
        { kind: 'balance_mismatch', address: alice, expected: 70n, observed: 71n },
      ]);
    });
  });

  describe('totals', () => {
    it('reports balance_mismatch, including an expected address that was not read', () => {
      const w = cleanWorld();
      const r = reconcile({ ...w, observedBalances: new Map([[alice, 70n]]) });
      expect(r.mismatches).toEqual([
        { kind: 'balance_mismatch', address: bob, expected: 20n, observed: null },
      ]);
    });

    it('reports supply_mismatch', () => {
      const w = cleanWorld();
      expect(reconcile({ ...w, observedSupply: 91n }).mismatches).toEqual([
        { kind: 'supply_mismatch', expected: 90n, observed: 91n },
      ]);
    });

    it('reports compliance_mismatch for differing or unread flags', () => {
      const w = cleanWorld();
      const r = reconcile({
        ...w,
        observedCompliance: new Map([
          [alice, OK],
          [bob, { verified: true, frozen: true }],
        ]),
      });
      expect(r.mismatches).toEqual([
        {
          kind: 'compliance_mismatch',
          address: bob,
          expected: OK,
          observed: { verified: true, frozen: true },
        },
        { kind: 'compliance_mismatch', address: mallory, expected: OK, observed: null },
      ]);
      const unverified = reconcile({
        ...w,
        observedCompliance: new Map([
          ...w.observedCompliance,
          [alice, { verified: false, frozen: false }],
        ]),
      });
      expect(unverified.mismatches).toEqual([
        expect.objectContaining({ kind: 'compliance_mismatch', address: alice }),
      ]);
    });

    it('checks every holder and every account a compliance event touched, expected or not', () => {
      const w = cleanWorld();
      const carol = addr(0xc);
      const dave = addr(0xd);
      const r = reconcile({
        ...w,
        // Only alice is expected; bob holds tokens, dave appears in a known compliance change.
        expectedCompliance: new Map([
          [alice, OK],
          [dave, OK],
        ]),
        observedCompliance: new Map([
          [alice, OK],
          [bob, OK],
          [carol, OK],
          [dave, OK],
        ]),
        events: [
          ...w.events,
          {
            ...pos(15, 6, 0),
            kind: 'VerificationSet',
            account: carol,
            verified: true,
            ref: refOf(54),
          },
        ],
        knownComplianceChanges: new Map([
          [refOf(54), { account: carol, flag: 'verified', value: true }],
        ]),
      });
      expect(r.mismatches).toEqual([
        { kind: 'compliance_mismatch', address: bob, expected: null, observed: OK },
        { kind: 'compliance_mismatch', address: carol, expected: null, observed: OK },
      ]);
    });

    it('does not ask for flags of an address whose observed balance is zero', () => {
      const w = cleanWorld();
      const r = reconcile({
        ...w,
        observedBalances: new Map([...w.observedBalances, [addr(0x77), 0n]]),
      });
      expect(r.ok).toBe(true);
    });
  });

  it('rejects an expectedSupply that is not the sum of expectedBalances, or a negative expectation', () => {
    const w = cleanWorld();
    expect(() => reconcile({ ...w, expectedSupply: 91n })).toThrow(InvalidInputError);
    expect(() => reconcile({ ...w, expectedSupply: 91n })).toThrow(/sum of expectedBalances/);
    expect(() =>
      reconcile({
        ...w,
        expectedBalances: new Map([
          [alice, 100n],
          [bob, -10n],
        ]),
      }),
    ).toThrow(/negative/);
  });

  it('rejects an inconsistent ledger view', () => {
    const w = cleanWorld();
    const first = w.operations[0] as LedgerOperationView;
    expect(() =>
      reconcile({ ...w, operations: [...w.operations, { ...first, id: 'dup' }] }),
    ).toThrow(InvalidInputError);
    expect(() => reconcile({ ...w, operations: [{ ...first, type: 'withdrawal' }] })).toThrow(
      /parties/,
    );
  });

  it('orders mismatches deterministically, independent of input order', () => {
    const w = cleanWorld();
    const messy: ReconciliationInput = {
      ...w,
      operations: [
        ...w.operations.map((o) => (o.id === 'op-dep' ? { ...o, amount: 101n } : o)),
        {
          id: 'op-x',
          ref: refOf(30),
          type: 'deposit',
          status: 'confirmed',
          amount: 1n,
          parties: { type: 'deposit', to: bob },
          confirmedBlock: 5n,
        },
        {
          id: 'op-a',
          ref: refOf(31),
          type: 'deposit',
          status: 'confirmed',
          amount: 1n,
          parties: { type: 'deposit', to: bob },
          confirmedBlock: 5n,
        },
      ],
      events: [
        ...w.events.map((e) =>
          e.kind === 'SettledTransfer' ? { ...e, from: mallory, to: mallory } : e,
        ),
        { ...pos(18, 11, 0), kind: 'Transfer', from: alice, to: mallory, amount: 3n },
        { ...pos(18, 11, 1), kind: 'Transfer', from: bob, to: mallory, amount: 3n },
        { ...pos(19, 12, 0), kind: 'Burned', from: alice, amount: 1n, ref: refOf(90) },
        { ...pos(19, 12, 1), kind: 'Burned', from: alice, amount: 1n, ref: refOf(91) },
        // A stale Transfer from an orphaned block, and a registry event nobody asked for.
        {
          ...pos(13, 13, 0),
          blockHash: bh('orphan13'),
          kind: 'Transfer',
          from: bob,
          to: alice,
          amount: 9n,
        },
        { ...pos(14, 14, 0), kind: 'FrozenSet', account: alice, frozen: false, ref: refOf(92) },
      ],
      observedBalances: new Map([
        [mallory, 6n],
        [alice, 1n],
        [bob, 2n],
      ]),
      observedSupply: 1n,
      expectedCompliance: new Map([
        [bob, OK],
        [alice, OK],
      ]),
      observedCompliance: new Map([
        [mallory, OK],
        [bob, { verified: true, frozen: true }],
        [alice, OK],
      ]),
    };
    const baseline = reconcile(messy);
    expect(baseline.mismatches.map((m) => m.kind)).toEqual([
      'missing_onchain',
      'missing_onchain',
      'amount_mismatch',
      'address_mismatch',
      'address_mismatch',
      'unexpected_onchain_event',
      'unexpected_onchain_event',
      'unexpected_onchain_event',
      'unexplained_transfer',
      'unexplained_transfer',
      'unexplained_transfer',
      'balance_mismatch',
      'balance_mismatch',
      'balance_mismatch',
      'supply_mismatch',
      'compliance_event_mismatch',
      'compliance_mismatch',
      'compliance_mismatch',
    ]);
    expect(baseline.mismatches[0]).toMatchObject({ operationId: 'op-a' });
    expect(baseline.mismatches[3]).toMatchObject({ field: 'from' });
    expect(baseline.mismatches[5]).toMatchObject({ why: 'stale_block', ref: null });
    expect(baseline.mismatches[16]).toMatchObject({ address: bob, expected: OK });
    expect(baseline.mismatches[17]).toMatchObject({ address: mallory, expected: null });

    const rand = prng(2024);
    const shuffle = <T>(xs: readonly T[]): T[] => {
      const a = [...xs];
      for (let i = a.length - 1; i > 0; i -= 1) {
        const j = randInt(rand, i + 1);
        [a[i], a[j]] = [a[j] as T, a[i] as T];
      }
      return a;
    };
    const reverseMap = <K, V>(m: ReadonlyMap<K, V>) => new Map([...m].reverse());
    for (let i = 0; i < 50; i += 1) {
      const shuffled = reconcile({
        ...messy,
        operations: shuffle(messy.operations),
        events: shuffle(messy.events),
        observedBalances: reverseMap(messy.observedBalances),
        expectedBalances: reverseMap(messy.expectedBalances),
        expectedCompliance: reverseMap(messy.expectedCompliance),
        observedCompliance: reverseMap(messy.observedCompliance),
        canonicalBlockHashes: reverseMap(messy.canonicalBlockHashes),
      });
      expect(shuffled).toEqual(baseline);
    }
  });
});
