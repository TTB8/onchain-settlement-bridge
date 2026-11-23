import {
  type Address,
  assertOperationJournal,
  buildEntry,
  type ChainStateOperation,
  expectedChainState,
  InvalidInputError,
  type JournalEntry,
  JournalIntegrityError,
  type LedgerOperation,
  onChainEffect,
  type OperationParties,
} from '../src';
import { addr, prng, randInt } from './support/fixtures';

const USERS = ['u0', 'u1', 'u2', 'u3'] as const;
const ADDRESS = new Map<string, Address>(USERS.map((u, i) => [u, addr(i + 1)]));
const A = (u: string) => ADDRESS.get(u) as Address;

function partiesOf(op: LedgerOperation): OperationParties {
  switch (op.type) {
    case 'deposit':
      return { type: 'deposit', to: A(op.userId) };
    case 'withdrawal':
      return { type: 'withdrawal', from: A(op.userId) };
    case 'transfer':
      return { type: 'transfer', from: A(op.fromUserId), to: A(op.toUserId) };
  }
}

const dep: LedgerOperation = { type: 'deposit', operationId: 'd1', userId: 'u0', amount: 100n };
const wd: LedgerOperation = { type: 'withdrawal', operationId: 'w1', userId: 'u0', amount: 30n };
const tr: LedgerOperation = {
  type: 'transfer',
  operationId: 't1',
  fromUserId: 'u0',
  toUserId: 'u1',
  amount: 20n,
};
const opsMap = (...ops: LedgerOperation[]) => new Map(ops.map((o) => [o.operationId, o]));

describe('assertOperationJournal', () => {
  it('accepts a valid history, including an operation with no entries yet', () => {
    expect(() =>
      assertOperationJournal(
        [
          buildEntry(dep, 'reserve'),
          buildEntry(dep, 'settle'),
          buildEntry(wd, 'reserve'),
          buildEntry(wd, 'reverse'),
          buildEntry(tr, 'reserve'),
          buildEntry(tr, 'settle'),
        ],
        opsMap(dep, wd, tr, { ...dep, operationId: 'never-reserved' }),
      ),
    ).not.toThrow();
  });

  it.each<[string, JournalEntry[]]>([
    ['a double reserve', [buildEntry(dep, 'reserve'), buildEntry(dep, 'reserve')]],
    ['a settle without a reserve', [buildEntry(dep, 'settle')]],
    ['a reverse without a reserve', [buildEntry(dep, 'reverse')]],
    [
      'a settle and then a reverse',
      [buildEntry(dep, 'reserve'), buildEntry(dep, 'settle'), buildEntry(dep, 'reverse')],
    ],
    [
      'a reverse and then a settle',
      [buildEntry(dep, 'reserve'), buildEntry(dep, 'reverse'), buildEntry(dep, 'settle')],
    ],
    [
      'a double settle',
      [buildEntry(dep, 'reserve'), buildEntry(dep, 'settle'), buildEntry(dep, 'settle')],
    ],
  ])('rejects %s', (_label, entries) => {
    expect(() => assertOperationJournal(entries, opsMap(dep))).toThrow(JournalIntegrityError);
    // The stage rule itself must catch it, not only the negative-balance rule behind it.
    expect(() => assertOperationJournal(entries, opsMap(dep))).toThrow(/after stage/);
  });

  it('rejects an entry for an unknown operation', () => {
    expect(() => assertOperationJournal([buildEntry(dep, 'reserve')], opsMap(wd))).toThrow(
      /unknown operation/,
    );
  });

  it('rejects an entry that does not match its operation (amount, account, side, length)', () => {
    const reserve = buildEntry(dep, 'reserve');
    const [dr, cr] = reserve.postings as [JournalEntry['postings'][0], JournalEntry['postings'][0]];
    const variants: JournalEntry[] = [
      buildEntry({ ...dep, amount: 99n }, 'reserve'),
      buildEntry({ ...dep, userId: 'u1' }, 'reserve'),
      {
        ...reserve,
        postings: [
          { ...dr, side: 'credit' },
          { ...cr, side: 'debit' },
        ],
      },
      { ...reserve, postings: [dr, cr, dr, cr] },
    ];
    for (const e of variants) {
      expect(() => assertOperationJournal([e], opsMap(dep))).toThrow(/does not match/);
    }
  });

  it('rejects a reserve that drives an account negative (spending funds not available)', () => {
    let err: unknown;
    try {
      assertOperationJournal([buildEntry(wd, 'reserve')], opsMap(wd));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(JournalIntegrityError);
    expect((err as JournalIntegrityError).operationId).toBe('w1');
    expect((err as JournalIntegrityError).code).toBe('JOURNAL_INTEGRITY');
    expect(String((err as Error).message)).toMatch(/negative/);
  });
});

describe('expectedChainState', () => {
  const entries = [
    buildEntry(dep, 'reserve'),
    buildEntry(dep, 'settle'),
    buildEntry(tr, 'reserve'),
    buildEntry(tr, 'settle'),
    buildEntry(wd, 'reserve'),
  ];
  const operations: ChainStateOperation[] = [
    { op: dep, parties: partiesOf(dep), confirmedBlock: 10n },
    { op: tr, parties: partiesOf(tr), confirmedBlock: 20n },
    { op: wd, parties: partiesOf(wd), confirmedBlock: null },
  ];
  const at = (atBlock: bigint) =>
    expectedChainState({ entries, operations, userAddresses: ADDRESS, atBlock, finalBlock: 30n });

  it('counts held funds (in-flight withdrawal) as still on chain', () => {
    expect(at(20n)).toEqual({
      balances: new Map([
        [A('u0'), 80n],
        [A('u1'), 20n],
      ]),
      supply: 100n,
    });
  });

  it('takes back settlements confirmed after atBlock, at exactly the boundary', () => {
    expect(at(19n)).toEqual({ balances: new Map([[A('u0'), 100n]]), supply: 100n });
    expect(at(9n)).toEqual({ balances: new Map(), supply: 0n });
    expect(at(10n).supply).toBe(100n);
  });

  it.each<[string, Partial<Parameters<typeof expectedChainState>[0]>]>([
    [
      'duplicate operation ids',
      { operations: [...operations, { op: dep, parties: partiesOf(dep), confirmedBlock: 10n }] },
    ],
    ['two users sharing an address', { userAddresses: new Map([...ADDRESS, ['u1', A('u0')]]) }],
    ['a user without an address', { userAddresses: new Map([['u0', A('u0')]]) }],
    [
      'parties that are not the users addresses',
      {
        operations: [
          { op: dep, parties: { type: 'deposit', to: A('u3') }, confirmedBlock: 10n },
          ...operations.slice(1),
        ],
      },
    ],
    [
      'a settled operation without a confirmedBlock',
      {
        operations: [
          { ...(operations[0] as ChainStateOperation), confirmedBlock: null },
          ...operations.slice(1),
        ],
      },
    ],
    [
      'an unsettled operation with a confirmedBlock',
      {
        operations: [
          ...operations.slice(0, 2),
          { op: wd, parties: partiesOf(wd), confirmedBlock: 5n },
        ],
      },
    ],
    [
      'confirmation blocks that contradict the journal order (a balance would go negative)',
      {
        operations: [
          { op: dep, parties: partiesOf(dep), confirmedBlock: 30n },
          { op: tr, parties: partiesOf(tr), confirmedBlock: 20n },
          { op: wd, parties: partiesOf(wd), confirmedBlock: null },
        ],
        atBlock: 25n,
        finalBlock: 30n,
      },
    ],
  ])('rejects %s', (_label, patch) => {
    expect(() =>
      expectedChainState({
        entries,
        operations,
        userAddresses: ADDRESS,
        atBlock: 20n,
        finalBlock: 20n,
        ...patch,
      }),
    ).toThrow(InvalidInputError);
  });

  it('rejects a settlement confirmed after finalBlock, and atBlock after finalBlock (review N-1)', () => {
    // The review's PoC shape: a settled deposit "confirmed" at block 10^18.
    const forged = [
      { op: dep, parties: partiesOf(dep), confirmedBlock: 10n ** 18n },
      ...operations.slice(1),
    ];
    expect(() =>
      expectedChainState({
        entries,
        operations: forged,
        userAddresses: ADDRESS,
        atBlock: 20n,
        finalBlock: 30n,
      }),
    ).toThrow(/after finalBlock/);
    expect(() =>
      expectedChainState({
        entries,
        operations,
        userAddresses: ADDRESS,
        atBlock: 31n,
        finalBlock: 30n,
      }),
    ).toThrow(InvalidInputError);
    // Exactly at finalBlock is fine.
    expect(
      expectedChainState({
        entries,
        operations,
        userAddresses: ADDRESS,
        atBlock: 20n,
        finalBlock: 20n,
      }).supply,
    ).toBe(100n);
  });

  it('runs the journal check first', () => {
    expect(() =>
      expectedChainState({
        entries: [...entries, buildEntry(dep, 'reverse')],
        operations,
        userAddresses: ADDRESS,
        atBlock: 20n,
        finalBlock: 20n,
      }),
    ).toThrow(JournalIntegrityError);
  });
});

describe('expectedChainState (seeded property test)', () => {
  /** One random valid history: operations settle in increasing blocks; some stay in flight. */
  function history(seed: number) {
    const rand = prng(seed);
    const entries: JournalEntry[] = [];
    const operations = new Map<string, ChainStateOperation>();
    const inFlight: LedgerOperation[] = [];
    const available = new Map<string, bigint>(USERS.map((u) => [u, 0n]));
    let block = 0n;
    const steps = 10 + randInt(rand, 30);
    for (let i = 0; i < steps; i += 1) {
      if (rand() < 0.55 || inFlight.length === 0) {
        const u = USERS[randInt(rand, USERS.length)] as string;
        const amount = BigInt(1 + randInt(rand, 500));
        const kind = randInt(rand, 3);
        const id = `s${seed}-${i}`;
        let op: LedgerOperation;
        if (kind === 0) op = { type: 'deposit', operationId: id, userId: u, amount };
        else if (kind === 1) op = { type: 'withdrawal', operationId: id, userId: u, amount };
        else {
          const v = USERS[
            (USERS.indexOf(u as (typeof USERS)[number]) + 1 + randInt(rand, 3)) % 4
          ] as string;
          op = { type: 'transfer', operationId: id, fromUserId: u, toUserId: v, amount };
        }
        if (op.type !== 'deposit') {
          if ((available.get(u) as bigint) < amount) continue;
          available.set(u, (available.get(u) as bigint) - amount);
        }
        entries.push(buildEntry(op, 'reserve'));
        operations.set(id, { op, parties: partiesOf(op), confirmedBlock: null });
        inFlight.push(op);
      } else {
        const op = inFlight.splice(randInt(rand, inFlight.length), 1)[0] as LedgerOperation;
        const settle = rand() < 0.7;
        entries.push(buildEntry(op, settle ? 'settle' : 'reverse'));
        if (settle) {
          block += BigInt(1 + randInt(rand, 3));
          operations.set(op.operationId, {
            op,
            parties: partiesOf(op),
            confirmedBlock: block,
          });
          if (op.type === 'deposit')
            available.set(op.userId, (available.get(op.userId) as bigint) + op.amount);
          if (op.type === 'transfer')
            available.set(op.toUserId, (available.get(op.toUserId) as bigint) + op.amount);
        } else if (op.type !== 'deposit') {
          const payer = op.type === 'transfer' ? op.fromUserId : op.userId;
          available.set(payer, (available.get(payer) as bigint) + op.amount);
        }
      }
    }
    return { entries, operations: [...operations.values()], maxBlock: block, rand };
  }

  it('equals the sum of onChainEffect of operations confirmed at or before atBlock (1500 seeds)', () => {
    let nonTrivial = 0;
    for (let seed = 1; seed <= 1500; seed += 1) {
      const h = history(seed);
      const atBlock = BigInt(randInt(h.rand, Number(h.maxBlock) + 2)) - 1n;
      const got = expectedChainState({
        entries: h.entries,
        operations: h.operations,
        userAddresses: ADDRESS,
        atBlock,
        finalBlock: h.maxBlock,
      });
      const want = new Map<Address, bigint>();
      for (const o of h.operations) {
        if (o.confirmedBlock === null || o.confirmedBlock > atBlock) continue;
        for (const { address, delta } of onChainEffect(o.parties, o.op.amount)) {
          want.set(address, (want.get(address) ?? 0n) + delta);
        }
      }
      for (const [a, v] of [...want]) if (v === 0n) want.delete(a);
      const supply = [...want.values()].reduce((s, v) => s + v, 0n);
      if (got.supply !== supply || got.balances.size !== want.size) {
        throw new Error(`seed ${seed}: supply ${got.supply} vs ${supply}`);
      }
      for (const [a, v] of want) {
        if (got.balances.get(a) !== v)
          throw new Error(`seed ${seed}: ${a} ${got.balances.get(a)} vs ${v}`);
      }
      if (supply > 0n && atBlock < h.maxBlock) nonTrivial += 1;
    }
    expect(nonTrivial).toBeGreaterThan(500);
  });

  it('rejects corrupted versions of random valid journals (double reserve, settle+reverse)', () => {
    let checked = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      const h = history(seed);
      const first = h.entries[0] as JournalEntry;
      const opsById = new Map(h.operations.map((o) => [o.op.operationId, o.op]));
      expect(() => assertOperationJournal([...h.entries, first], opsById)).toThrow(
        JournalIntegrityError,
      );
      const finished = h.entries.find((e) => e.kind !== 'reserve');
      if (finished !== undefined) {
        const op = opsById.get(finished.operationId) as LedgerOperation;
        const other = buildEntry(op, finished.kind === 'settle' ? 'reverse' : 'settle');
        expect(() => assertOperationJournal([...h.entries, other], opsById)).toThrow(
          JournalIntegrityError,
        );
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(200);
  });
});
