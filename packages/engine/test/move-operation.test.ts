/**
 * moveOperation: the single helper for status moves. Real Postgres for the writes; a tripwire
 * transaction client for "an illegal edge or refused evidence is caught before the database is
 * touched".
 */

import type { FailureReason, ReversalEvidence, SettlementJudgement } from '@bridge/domain';

import {
  EvidenceRefusedError,
  IllegalTransitionError,
  InvalidRequestError,
  moveOperation,
  type MoveOperationInput,
  OperationNotFoundError,
  type OperationRecord,
  type OperationService,
  type Tx,
  VersionConflictError,
} from '../src';
import { createTestDatabase, type TestDatabase } from './support/database';
import {
  balanceOf,
  counts,
  fund,
  insertDeployment,
  insertUser,
  line,
  postingsOf,
  serviceFor,
  type TestDeployment,
  type TestUser,
} from './support/fixtures';

let db: TestDatabase;
let dep: TestDeployment;
let service: OperationService;
const AT = new Date(Date.UTC(2026, 10, 23, 13, 0, 0));
const CONFIRM: SettlementJudgement = { verdict: 'confirm', event: 'CONFIRM' };
/** Evidence `mayReverse` accepts, for the given stored reason. */
const SAFE = (failureReason: FailureReason): ReversalEvidence => ({
  failureReason,
  anAttemptCanStillMine: false,
  chainHasEventForRef: false,
  referenceConsumedOnChain: false,
});

beforeAll(async () => {
  db = await createTestDatabase();
  dep = await insertDeployment(db.prisma);
  service = serviceFor(db.prisma, dep);
});

afterAll(async () => {
  await db?.drop();
});

let keyN = 0;
const key = () => `mv-${(keyN += 1)}`;
type Rest = Omit<MoveOperationInput, 'operationId' | 'at' | 'note'>;

function input(op: { id: string }, rest: Rest) {
  return { operationId: op.id, at: AT, note: 'test', ...rest };
}

async function submitted(op: OperationRecord) {
  return service.move(
    input(op, { from: 'ledger_reserved', version: 0, move: { event: 'SUBMIT', kind: 'first' } }),
  );
}

const tripwire = (): { tx: Tx; touched: () => number } => {
  let n = 0;
  const tx = new Proxy(
    {},
    {
      get() {
        n += 1;
        throw new Error('the database was touched');
      },
    },
  ) as Tx;
  return { tx, touched: () => n };
};

async function refusedBeforeDb(rest: Rest, cls: new (...a: never[]) => Error): Promise<void> {
  const { tx, touched } = tripwire();
  await expect(
    moveOperation(tx, input({ id: '00000000-0000-4000-8000-000000000000' }, rest)),
  ).rejects.toBeInstanceOf(cls);
  expect(touched()).toBe(0);
}

describe('illegal edges are refused before the database is touched', () => {
  const cases: [string, Rest][] = [
    [
      'ledger_reserved CONFIRM',
      {
        from: 'ledger_reserved',
        version: 1,
        move: { event: 'CONFIRM', judgement: CONFIRM, confirmedBlock: 1n },
      },
    ],
    [
      'confirmed SUBMIT',
      { from: 'confirmed', version: 3, move: { event: 'SUBMIT', kind: 'bump' } },
    ],
    [
      'reversed REVERSE',
      { from: 'reversed', version: 3, move: { event: 'REVERSE', evidence: SAFE('reverted') } },
    ],
    ['failed FAIL', { from: 'failed', version: 2, move: { event: 'FAIL', reason: 'reverted' } }],
    [
      'submitted REVERSE',
      { from: 'submitted', version: 1, move: { event: 'REVERSE', evidence: SAFE('reverted') } },
    ],
    [
      'failed CONFIRM (late only via the gate)',
      {
        from: 'failed',
        version: 2,
        move: { event: 'CONFIRM', judgement: CONFIRM, confirmedBlock: 1n },
      },
    ],
    [
      'CONFIRM_LATE from submitted',
      {
        from: 'submitted',
        version: 1,
        move: { event: 'CONFIRM_LATE', judgement: CONFIRM, confirmedBlock: 1n },
      },
    ],
    [
      'RESERVE (reservations go through the service)',
      { from: 'requested', version: 0, move: { event: 'RESERVE' } as never },
    ],
    [
      'a first SUBMIT from submitted',
      { from: 'submitted', version: 1, move: { event: 'SUBMIT', kind: 'first' } },
    ],
    [
      'a bump from ledger_reserved',
      { from: 'ledger_reserved', version: 0, move: { event: 'SUBMIT', kind: 'bump' } },
    ],
    [
      'a resubmit from ledger_reserved',
      {
        from: 'ledger_reserved',
        version: 0,
        move: { event: 'SUBMIT', kind: 'resubmit', resubmitsSoFar: 0 },
      },
    ],
  ];

  it.each(cases)('%s', (_name, rest) => refusedBeforeDb(rest, IllegalTransitionError));

  it.each([
    [
      'a negative version',
      { from: 'submitted', version: -1, move: { event: 'SUBMIT', kind: 'bump' } },
    ],
    [
      'a fractional version',
      { from: 'submitted', version: 1.5, move: { event: 'SUBMIT', kind: 'bump' } },
    ],
    [
      'a negative block',
      {
        from: 'submitted',
        version: 1,
        move: { event: 'CONFIRM', judgement: CONFIRM, confirmedBlock: -1n },
      },
    ],
    [
      'FAIL without a reason',
      { from: 'submitted', version: 1, move: { event: 'FAIL', reason: '' } },
    ],
    [
      'an unknown SUBMIT kind',
      { from: 'submitted', version: 1, move: { event: 'SUBMIT', kind: 'x' } },
    ],
    [
      'a negative resubmit count',
      {
        from: 'submitted',
        version: 1,
        move: { event: 'SUBMIT', kind: 'resubmit', resubmitsSoFar: -1 },
      },
    ],
    [
      'REVERSE without evidence',
      { from: 'failed', version: 1, move: { event: 'REVERSE', evidence: {} } },
    ],
  ] as unknown as [string, Rest][])('refuses %s as an invalid request', (_name, rest) =>
    refusedBeforeDb(rest, InvalidRequestError),
  );
});

describe('evidence is checked by moveOperation itself (review M-3)', () => {
  const judgements: [string, unknown][] = [
    ['wait', { verdict: 'wait' }],
    [
      'reference_conflict',
      { verdict: 'reference_conflict', reason: 'reference_conflict', differences: [] },
    ],
    ['a failed RevertResolution', { verdict: 'failed', event: 'FAIL', reason: 'reverted' }],
    [
      'a forged literal: confirm verdict with the FAIL event',
      { verdict: 'confirm', event: 'FAIL' },
    ],
    ['a forged literal: wrong case', { verdict: 'Confirm', event: 'CONFIRM' }],
    ['null', null],
  ];

  it.each(judgements)('CONFIRM with %s is refused', (_name, judgement) =>
    refusedBeforeDb(
      {
        from: 'submitted',
        version: 1,
        move: { event: 'CONFIRM', judgement: judgement as SettlementJudgement, confirmedBlock: 1n },
      },
      EvidenceRefusedError,
    ),
  );

  it.each(judgements)('CONFIRM_LATE with %s is refused', (_name, judgement) =>
    refusedBeforeDb(
      {
        from: 'failed',
        version: 2,
        move: {
          event: 'CONFIRM_LATE',
          judgement: judgement as SettlementJudgement,
          confirmedBlock: 1n,
        },
      },
      EvidenceRefusedError,
    ),
  );

  const unsafe: [string, ReversalEvidence][] = [
    ['a duplicate_reference failure', SAFE('duplicate_reference')],
    ['a reference_conflict failure', SAFE('reference_conflict')],
    ['a still-mineable attempt', { ...SAFE('reverted'), anAttemptCanStillMine: true }],
    ['an event for the reference', { ...SAFE('reverted'), chainHasEventForRef: true }],
    ['a consumed reference', { ...SAFE('dropped'), referenceConsumedOnChain: true }],
  ];

  it.each(unsafe)('REVERSE with %s is refused', (_name, evidence) =>
    refusedBeforeDb(
      { from: 'failed', version: 1, move: { event: 'REVERSE', evidence } },
      EvidenceRefusedError,
    ),
  );

  it('REVERSE with evidence for another failure reason than the stored one is refused', async () => {
    const u = await insertUser(db.prisma);
    await fund(service, u, 30n);
    const { operation } = await service.requestWithdrawal(u.id, 10n, key());
    await service.move(
      input(operation, {
        from: 'ledger_reserved',
        version: 0,
        move: { event: 'FAIL', reason: 'duplicate_reference' },
      }),
    );
    const before = await counts(db.prisma);
    // Evidence gathered as if it had merely reverted: mayReverse says yes, the stored reason says no.
    await expect(
      service.move(
        input(operation, {
          from: 'failed',
          version: 1,
          move: { event: 'REVERSE', evidence: SAFE('reverted') },
        }),
      ),
    ).rejects.toBeInstanceOf(EvidenceRefusedError);
    expect(await counts(db.prisma)).toEqual(before);
    const row = await db.prisma.operation.findUniqueOrThrow({ where: { id: operation.id } });
    expect(row).toMatchObject({ status: 'failed', version: 1 });
    expect(await balanceOf(db.prisma, u.held)).toBe(10n);
  });
});

describe('legal moves', () => {
  it('SUBMIT first / bump / resubmit: status, literal version and resubmit count, audit row', async () => {
    const u = await insertUser(db.prisma);
    const { operation } = await service.requestDeposit(u.id, 10n, key());
    const before = await counts(db.prisma);
    const moved = await service.move({
      ...input(operation, {
        from: 'ledger_reserved',
        version: 0,
        move: { event: 'SUBMIT', kind: 'first' },
      }),
      txHash: `0x${'ab'.repeat(32)}`,
    });
    expect(moved).toEqual({
      id: operation.id,
      status: 'submitted',
      version: 1,
      entryKind: null,
      cancelledOutbox: 0,
    });
    const row = await db.prisma.operation.findUniqueOrThrow({ where: { id: operation.id } });
    expect(row).toMatchObject({
      status: 'submitted',
      version: 1,
      updatedAt: AT,
      resubmitsSoFar: 0,
    });
    const after = await counts(db.prisma);
    expect(after).toEqual({ ...before, audit: before.audit + 1 });
    const audit = await db.prisma.auditLog.findFirstOrThrow({
      where: { entityId: operation.id },
      orderBy: { id: 'desc' },
    });
    expect(audit).toMatchObject({
      entity: 'operation',
      fromState: 'ledger_reserved',
      toState: 'submitted',
      txHash: `0x${'ab'.repeat(32)}`,
      at: AT,
    });
    expect(audit.detail).toMatchObject({
      event: 'SUBMIT',
      submitKind: 'first',
      version: 1,
      note: 'test',
    });

    const bump = await service.move(
      input(operation, { from: 'submitted', version: 1, move: { event: 'SUBMIT', kind: 'bump' } }),
    );
    expect(bump.version).toBe(2);
    expect(
      (await db.prisma.operation.findUniqueOrThrow({ where: { id: operation.id } })).resubmitsSoFar,
    ).toBe(0);

    const re = await service.move(
      input(operation, {
        from: 'submitted',
        version: 2,
        move: { event: 'SUBMIT', kind: 'resubmit', resubmitsSoFar: 0 },
      }),
    );
    expect(re.version).toBe(3);
    expect(
      await db.prisma.operation.findUniqueOrThrow({ where: { id: operation.id } }),
    ).toMatchObject({
      version: 3,
      resubmitsSoFar: 1,
    });
    // A resubmit from a stale counter (right version) changes nothing.
    await expect(
      service.move(
        input(operation, {
          from: 'submitted',
          version: 3,
          move: { event: 'SUBMIT', kind: 'resubmit', resubmitsSoFar: 0 },
        }),
      ),
    ).rejects.toBeInstanceOf(VersionConflictError);
    expect(
      await db.prisma.operation.findUniqueOrThrow({ where: { id: operation.id } }),
    ).toMatchObject({
      version: 3,
      resubmitsSoFar: 1,
    });
  });

  it("the caller's note is sanitized before it reaches the audit row", async () => {
    const u = await insertUser(db.prisma);
    const { operation } = await service.requestDeposit(u.id, 1n, key());
    const note = 'sent via https://eth.example.org/v2/NOTEKEY77 (eth.example.org/v2/NOTEKEY77)';
    expect(note).toContain('NOTEKEY77');
    await service.move({
      operationId: operation.id,
      from: 'ledger_reserved',
      version: 0,
      move: { event: 'SUBMIT', kind: 'first' },
      at: AT,
      note,
    });
    const audit = await db.prisma.auditLog.findFirstOrThrow({
      where: { entityId: operation.id },
      orderBy: { id: 'desc' },
    });
    const written = (audit.detail as { note?: string }).note;
    expect(written).toBe('sent via <redacted-url> (<redacted-url>)');
  });

  it('CONFIRM writes the settle entry from the domain table, for each type', async () => {
    const u = await insertUser(db.prisma);
    const v = await insertUser(db.prisma);
    await fund(service, u, 100n);
    expect(await balanceOf(db.prisma, u.incoming)).toBe(0n);
    expect(await balanceOf(db.prisma, u.available)).toBe(100n);

    const w = (await service.requestWithdrawal(u.id, 30n, key())).operation;
    const t = (await service.requestTransfer(u.id, v.id, 20n, key())).operation;
    for (const op of [w, t]) {
      const s = await submitted(op);
      const done = await service.move(
        input(op, {
          from: 'submitted',
          version: s.version,
          move: { event: 'CONFIRM', judgement: CONFIRM, confirmedBlock: 77n },
        }),
      );
      expect(done).toMatchObject({
        status: 'confirmed',
        version: 2,
        entryKind: 'settle',
        cancelledOutbox: 0,
      });
      const row = await db.prisma.operation.findUniqueOrThrow({ where: { id: op.id } });
      expect(row.confirmedBlock).toBe(77n);
    }
    expect(await postingsOf(db.prisma, w.id, 'settle')).toEqual(
      [line(u.held, 'debit', 30n), line(db.fiatId, 'credit', 30n)].sort(),
    );
    expect(await postingsOf(db.prisma, t.id, 'settle')).toEqual(
      [line(u.held, 'debit', 20n), line(v.available, 'credit', 20n)].sort(),
    );
    expect(await balanceOf(db.prisma, u.available)).toBe(50n);
    expect(await balanceOf(db.prisma, u.held)).toBe(0n);
    expect(await balanceOf(db.prisma, v.available)).toBe(20n);
  });

  async function failedBeforeSending(u: TestUser, kind: 'deposit' | 'withdrawal') {
    const op =
      kind === 'deposit'
        ? (await service.requestDeposit(u.id, 15n, key())).operation
        : (await service.requestWithdrawal(u.id, 15n, key())).operation;
    const f = await service.move(
      input(op, {
        from: 'ledger_reserved',
        version: 0,
        move: { event: 'FAIL', reason: 'compliance_rejected' },
      }),
    );
    // Nothing was sent: the pending outbox row is cancelled in the same transaction.
    expect(f).toMatchObject({ status: 'failed', version: 1, entryKind: null, cancelledOutbox: 1 });
    const outbox = await db.prisma.outboxMessage.findFirstOrThrow({
      where: { operationId: op.id },
    });
    expect(outbox).toMatchObject({
      status: 'dead',
      lockedBy: null,
      lastError: 'cancelled: operation moved ledger_reserved -> failed',
      lastErrorAt: AT,
    });
    return op;
  }

  it('FAIL records the reason; REVERSE with evidence writes the reverse entry', async () => {
    const u = await insertUser(db.prisma);
    await fund(service, u, 40n);
    const w = await failedBeforeSending(u, 'withdrawal');
    const d = await failedBeforeSending(u, 'deposit');
    expect(
      (await db.prisma.operation.findUniqueOrThrow({ where: { id: w.id } })).failureReason,
    ).toBe('compliance_rejected');
    expect(await balanceOf(db.prisma, u.held)).toBe(15n); // still held while failed
    for (const op of [w, d]) {
      const r = await service.move(
        input(op, {
          from: 'failed',
          version: 1,
          move: { event: 'REVERSE', evidence: SAFE('compliance_rejected') },
        }),
      );
      expect(r).toMatchObject({
        status: 'reversed',
        version: 2,
        entryKind: 'reverse',
        cancelledOutbox: 0,
      });
    }
    expect(await postingsOf(db.prisma, w.id, 'reverse')).toEqual(
      [line(u.held, 'debit', 15n), line(u.available, 'credit', 15n)].sort(),
    );
    expect(await postingsOf(db.prisma, d.id, 'reverse')).toEqual(
      [line(u.incoming, 'debit', 15n), line(db.fiatId, 'credit', 15n)].sort(),
    );
    expect(await balanceOf(db.prisma, u.available)).toBe(40n);
    expect(await balanceOf(db.prisma, u.held)).toBe(0n);
    expect(await balanceOf(db.prisma, u.incoming)).toBe(0n);
  });

  it('a FAIL after sending leaves the outbox row alone; the REVERSE then kills it', async () => {
    const u = await insertUser(db.prisma);
    await fund(service, u, 20n);
    const { operation } = await service.requestWithdrawal(u.id, 5n, key());
    await submitted(operation);
    const f = await service.move(
      input(operation, {
        from: 'submitted',
        version: 1,
        move: { event: 'FAIL', reason: 'reverted' },
      }),
    );
    expect(f.cancelledOutbox).toBe(0);
    expect(
      (await db.prisma.outboxMessage.findFirstOrThrow({ where: { operationId: operation.id } }))
        .status,
    ).toBe('pending');
    const r = await service.move(
      input(operation, {
        from: 'failed',
        version: 2,
        move: { event: 'REVERSE', evidence: SAFE('reverted') },
      }),
    );
    expect(r.cancelledOutbox).toBe(1);
    expect(
      await db.prisma.outboxMessage.findFirstOrThrow({ where: { operationId: operation.id } }),
    ).toMatchObject({
      status: 'dead',
      lastError: 'cancelled: operation moved failed -> reversed',
    });
  });

  it('a processing (claimed) outbox row is cancelled too, and its lease is dropped', async () => {
    const u = await insertUser(db.prisma);
    const { operation } = await service.requestDeposit(u.id, 5n, key());
    await db.prisma.outboxMessage.updateMany({
      where: { operationId: operation.id },
      data: { status: 'processing', lockedAt: AT, lockedBy: 'w/1' },
    });
    const f = await service.move(
      input(operation, {
        from: 'ledger_reserved',
        version: 0,
        move: { event: 'FAIL', reason: 'rejected' },
      }),
    );
    expect(f.cancelledOutbox).toBe(1);
    expect(
      await db.prisma.outboxMessage.findFirstOrThrow({ where: { operationId: operation.id } }),
    ).toMatchObject({
      status: 'dead',
      lockedAt: null,
      lockedBy: null,
    });
  });

  it('CONFIRM_LATE settles a failed operation with a confirm judgement', async () => {
    const u = await insertUser(db.prisma);
    await fund(service, u, 40n);
    const w = await failedBeforeSending(u, 'withdrawal');
    const r = await service.move(
      input(w, {
        from: 'failed',
        version: 1,
        move: { event: 'CONFIRM_LATE', judgement: CONFIRM, confirmedBlock: 9n },
      }),
    );
    expect(r).toMatchObject({ status: 'confirmed', version: 2, entryKind: 'settle' });
    const row = await db.prisma.operation.findUniqueOrThrow({ where: { id: w.id } });
    expect(row).toMatchObject({ confirmedBlock: 9n, failureReason: 'compliance_rejected' });
    expect(await postingsOf(db.prisma, w.id, 'settle')).toEqual(
      [line(u.held, 'debit', 15n), line(db.fiatId, 'credit', 15n)].sort(),
    );
  });
});

describe('stale reads', () => {
  it('a stale version is refused with VersionConflictError and changes nothing', async () => {
    const u = await insertUser(db.prisma);
    const { operation } = await service.requestDeposit(u.id, 5n, key());
    await submitted(operation); // now version 1
    const before = await counts(db.prisma);
    await expect(
      service.move(
        input(operation, {
          from: 'submitted',
          version: 0,
          move: { event: 'SUBMIT', kind: 'bump' },
        }),
      ),
    ).rejects.toBeInstanceOf(VersionConflictError);
    expect(await counts(db.prisma)).toEqual(before);
    const row = await db.prisma.operation.findUniqueOrThrow({ where: { id: operation.id } });
    expect(row).toMatchObject({ status: 'submitted', version: 1 });
  });

  it('the right version but a stale status is a conflict too', async () => {
    const u = await insertUser(db.prisma);
    const { operation } = await service.requestDeposit(u.id, 5n, key());
    await submitted(operation);
    await expect(
      service.move(
        input(operation, {
          from: 'ledger_reserved',
          version: 1,
          move: { event: 'FAIL', reason: 'rejected' },
        }),
      ),
    ).rejects.toBeInstanceOf(VersionConflictError);
  });

  it('a REVERSE from a stale read is a version conflict, not an evidence refusal', async () => {
    const u = await insertUser(db.prisma);
    await fund(service, u, 10n);
    const { operation } = await service.requestWithdrawal(u.id, 5n, key());
    await service.move(
      input(operation, {
        from: 'ledger_reserved',
        version: 0,
        move: { event: 'FAIL', reason: 'dropped' },
      }),
    );
    await expect(
      service.move(
        input(operation, {
          from: 'failed',
          version: 0,
          move: { event: 'REVERSE', evidence: SAFE('dropped') },
        }),
      ),
    ).rejects.toBeInstanceOf(VersionConflictError);
  });

  it('two writers from one read: exactly one wins', async () => {
    const u = await insertUser(db.prisma);
    const { operation } = await service.requestDeposit(u.id, 5n, key());
    const results = await Promise.allSettled([
      service.move(
        input(operation, {
          from: 'ledger_reserved',
          version: 0,
          move: { event: 'SUBMIT', kind: 'first' },
        }),
      ),
      service.move(
        input(operation, {
          from: 'ledger_reserved',
          version: 0,
          move: { event: 'FAIL', reason: 'rejected' },
        }),
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(VersionConflictError);
    const row = await db.prisma.operation.findUniqueOrThrow({ where: { id: operation.id } });
    expect(row.version).toBe(1);
  });

  it('an unknown operation is OperationNotFoundError', async () => {
    await expect(
      service.move(
        input(
          { id: '00000000-0000-4000-8000-0000000000ff' },
          { from: 'submitted', version: 1, move: { event: 'SUBMIT', kind: 'bump' } },
        ),
      ),
    ).rejects.toBeInstanceOf(OperationNotFoundError);
  });

  it("joins the caller's transaction: a rollback undoes the move and its rows", async () => {
    const u = await insertUser(db.prisma);
    const { operation } = await service.requestDeposit(u.id, 5n, key());
    const before = await counts(db.prisma);
    await expect(
      db.prisma.$transaction(async (tx) => {
        await moveOperation(
          tx,
          input(operation, {
            from: 'ledger_reserved',
            version: 0,
            move: { event: 'FAIL', reason: 'rejected' },
          }),
        );
        throw new Error('caller failed after the move');
      }),
    ).rejects.toThrow('caller failed');
    expect(await counts(db.prisma)).toEqual(before);
    const row = await db.prisma.operation.findUniqueOrThrow({ where: { id: operation.id } });
    expect(row).toMatchObject({ status: 'ledger_reserved', version: 0 });
    expect(
      (await db.prisma.outboxMessage.findFirstOrThrow({ where: { operationId: operation.id } }))
        .status,
    ).toBe('pending');
  });
});
