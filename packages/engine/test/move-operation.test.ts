/**
 * moveOperation: the single helper for status moves. Real Postgres for the writes; a tripwire
 * transaction client for "an illegal edge is refused before the database is touched".
 */

import type { SettlementJudgement } from '@bridge/domain';

import {
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

function input(op: { id: string }, rest: Omit<MoveOperationInput, 'operationId' | 'at' | 'note'>) {
  return { operationId: op.id, at: AT, note: 'test', ...rest };
}

async function submitted(op: OperationRecord) {
  return service.move(
    input(op, { from: 'ledger_reserved', version: 0, move: { event: 'SUBMIT' } }),
  );
}

describe('illegal edges are refused before the database is touched', () => {
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

  const cases: [string, Omit<MoveOperationInput, 'operationId' | 'at' | 'note'>][] = [
    [
      'ledger_reserved CONFIRM',
      { from: 'ledger_reserved', version: 1, move: { event: 'CONFIRM', confirmedBlock: 1n } },
    ],
    ['confirmed SUBMIT', { from: 'confirmed', version: 3, move: { event: 'SUBMIT' } }],
    ['reversed REVERSE', { from: 'reversed', version: 3, move: { event: 'REVERSE' } }],
    ['failed FAIL', { from: 'failed', version: 2, move: { event: 'FAIL', reason: 'reverted' } }],
    ['submitted REVERSE', { from: 'submitted', version: 1, move: { event: 'REVERSE' } }],
    [
      'failed CONFIRM (late only via the gate)',
      { from: 'failed', version: 2, move: { event: 'CONFIRM', confirmedBlock: 1n } },
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
      'CONFIRM_LATE on a wait judgement',
      {
        from: 'failed',
        version: 2,
        move: { event: 'CONFIRM_LATE', judgement: { verdict: 'wait' }, confirmedBlock: 1n },
      },
    ],
    [
      'RESERVE (reservations go through the service)',
      { from: 'requested', version: 0, move: { event: 'RESERVE' } as never },
    ],
  ];

  it.each(cases)('%s', async (_name, rest) => {
    const { tx, touched } = tripwire();
    await expect(
      moveOperation(tx, input({ id: '00000000-0000-4000-8000-000000000000' }, rest)),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
    expect(touched()).toBe(0);
  });

  it.each([
    ['a negative version', { from: 'submitted', version: -1, move: { event: 'SUBMIT' } }],
    ['a fractional version', { from: 'submitted', version: 1.5, move: { event: 'SUBMIT' } }],
    [
      'a negative block',
      { from: 'submitted', version: 1, move: { event: 'CONFIRM', confirmedBlock: -1n } },
    ],
    [
      'FAIL without a reason',
      { from: 'submitted', version: 1, move: { event: 'FAIL', reason: '' } },
    ],
  ] as [string, Omit<MoveOperationInput, 'operationId' | 'at' | 'note'>][])(
    'refuses %s as an invalid request',
    async (_name, rest) => {
      const { tx, touched } = tripwire();
      await expect(
        moveOperation(tx, input({ id: '00000000-0000-4000-8000-000000000000' }, rest)),
      ).rejects.toBeInstanceOf(InvalidRequestError);
      expect(touched()).toBe(0);
    },
  );
});

describe('legal moves', () => {
  it('SUBMIT: status, literal version, clock time, audit row, no entry', async () => {
    const u = await insertUser(db.prisma);
    const { operation } = await service.requestDeposit(u.id, 10n, key());
    const before = await counts(db.prisma);
    const moved = await service.move({
      ...input(operation, { from: 'ledger_reserved', version: 0, move: { event: 'SUBMIT' } }),
      txHash: `0x${'ab'.repeat(32)}`,
    });
    expect(moved).toEqual({ id: operation.id, status: 'submitted', version: 1, entryKind: null });
    const row = await db.prisma.operation.findUniqueOrThrow({ where: { id: operation.id } });
    expect(row).toMatchObject({ status: 'submitted', version: 1, updatedAt: AT });
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
    expect(audit.detail).toMatchObject({ event: 'SUBMIT', version: 1, note: 'test' });

    // A fee bump or resubmission is submitted -> submitted, version 2.
    const again = await service.move(
      input(operation, { from: 'submitted', version: 1, move: { event: 'SUBMIT' } }),
    );
    expect(again.version).toBe(2);
  });

  it('CONFIRM writes the settle entry from the domain table, for each type', async () => {
    const u = await insertUser(db.prisma);
    const v = await insertUser(db.prisma);
    await fund(service, u, 100n);
    // fund() confirmed a deposit: incoming -> available.
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
          move: { event: 'CONFIRM', confirmedBlock: 77n },
        }),
      );
      expect(done).toMatchObject({ status: 'confirmed', version: 2, entryKind: 'settle' });
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

  async function failed(u: TestUser, kind: 'deposit' | 'withdrawal') {
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
    expect(f).toMatchObject({ status: 'failed', version: 1, entryKind: null });
    return op;
  }

  it('FAIL records the reason; REVERSE writes the reverse entry', async () => {
    const u = await insertUser(db.prisma);
    await fund(service, u, 40n);
    const w = await failed(u, 'withdrawal');
    const d = await failed(u, 'deposit');
    expect(
      (await db.prisma.operation.findUniqueOrThrow({ where: { id: w.id } })).failureReason,
    ).toBe('compliance_rejected');
    expect(await balanceOf(db.prisma, u.held)).toBe(15n); // still held while failed
    for (const op of [w, d]) {
      const r = await service.move(
        input(op, { from: 'failed', version: 1, move: { event: 'REVERSE' } }),
      );
      expect(r).toMatchObject({ status: 'reversed', version: 2, entryKind: 'reverse' });
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

  it('CONFIRM_LATE settles a failed operation with a confirm judgement only', async () => {
    const u = await insertUser(db.prisma);
    await fund(service, u, 40n);
    const w = await failed(u, 'withdrawal');
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
      service.move(input(operation, { from: 'submitted', version: 0, move: { event: 'SUBMIT' } })),
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

  it('two writers from one read: exactly one wins', async () => {
    const u = await insertUser(db.prisma);
    const { operation } = await service.requestDeposit(u.id, 5n, key());
    const results = await Promise.allSettled([
      service.move(
        input(operation, { from: 'ledger_reserved', version: 0, move: { event: 'SUBMIT' } }),
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
          { from: 'submitted', version: 1, move: { event: 'SUBMIT' } },
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
          input(operation, { from: 'ledger_reserved', version: 0, move: { event: 'SUBMIT' } }),
        );
        throw new Error('caller failed after the move');
      }),
    ).rejects.toThrow('caller failed');
    expect(await counts(db.prisma)).toEqual(before);
    const row = await db.prisma.operation.findUniqueOrThrow({ where: { id: operation.id } });
    expect(row).toMatchObject({ status: 'ledger_reserved', version: 0 });
  });
});
