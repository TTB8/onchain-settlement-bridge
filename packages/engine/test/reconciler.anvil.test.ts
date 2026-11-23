/**
 * Piece C against a REAL chain: a native `anvil` spawned for this file on a free port (stopped in
 * afterAll), the real contracts from the forge artifacts, the real `ViemChainGateway` and
 * `ViemTransactionInspector`, and Postgres.
 *
 * allow (through the bridge's compliance path) -> deposit -> transfer (`settleTransfer`, the
 * bridge path the contract allows with holder transfers OFF) -> withdrawal, then the reconciler
 * at the final block: ZERO mismatches. Then the admin switches holder transfers ON and a holder
 * moves tokens directly with `transfer` (bypassing the bridge): the reconciler catches it.
 *
 * DEV ONLY (labelled): the only keys are Anvil's public development accounts, derived at runtime
 * from the public test mnemonic by the chain package's test support; worthless on any network.
 */

import { randomUUID } from 'node:crypto';

import {
  AlarmLog,
  BridgeEngine,
  type ReconciliationRunRecord,
  ViemTransactionInspector,
} from '../src';
import {
  type AnvilNode,
  deployBridge,
  type Deployment,
  gatewayFor,
  holderTransferOnChain,
  setHolderTransfersOnChain,
  startAnvil,
} from '../../chain/test/support/anvil';
import { DEV_ROLES, devAddress } from '../../chain/test/support/dev-accounts';
import { createTestDatabase, type TestDatabase } from './support/database';
import { FakeClock, RecordingIds, type TestUser } from './support/fixtures';
import { ledgerHolding } from './support/bridge';

const CHAIN_ID = 31337;

let db: TestDatabase;
let node: AnvilNode;
let bridge: Deployment;

beforeAll(async () => {
  db = await createTestDatabase();
  node = await startAnvil();
  bridge = await deployBridge(node);
}, 120_000);

afterAll(async () => {
  await node?.stop();
  await db?.drop();
});

it('allow -> deposit -> transfer -> withdrawal on Anvil reconciles with ZERO mismatches; a direct holder transfer is caught', async () => {
  const gateway = gatewayFor(node, bridge);
  const head = await gateway.getHeadBlock();
  const d = await db.prisma.deployment.create({
    data: {
      chainId: BigInt(CHAIN_ID),
      tokenAddress: bridge.token,
      registryAddress: bridge.registry,
      deploymentBlock: head,
      active: true,
    },
  });
  await db.prisma.signerState.createMany({
    data: [
      { deploymentId: d.id, signer: 'settlement', address: gateway.signerAddress('settlement') },
      { deploymentId: d.id, signer: 'compliance', address: gateway.signerAddress('compliance') },
    ],
  });

  const users: TestUser[] = [];
  for (const role of ['alice', 'bob'] as const) {
    const wallet = devAddress(role);
    const u = await db.prisma.user.create({ data: { walletAddress: wallet } });
    const make = async (kind: 'user_available' | 'user_held' | 'user_incoming') =>
      (await db.prisma.account.create({ data: { kind, userId: u.id } })).id;
    users.push({
      id: u.id,
      wallet,
      available: await make('user_available'),
      held: await make('user_held'),
      incoming: await make('user_incoming'),
    });
  }
  const [alice, bob] = users as [TestUser, TestUser];

  const alarms = new AlarmLog();
  const engine = new BridgeEngine(
    {
      prisma: db.prisma,
      gateway,
      inspector: new ViemTransactionInspector(),
      clock: new FakeClock(),
      ids: new RecordingIds(),
      alarms,
    },
    {
      chainId: BigInt(CHAIN_ID),
      tokenAddress: bridge.token,
      workerId: 'anvil-worker-c',
      confirmationDepth: 2,
      feeCap: 10n ** 12n,
      lockTimeoutMs: 60_000,
      handlerTimeoutMs: 20_000,
      reconcileEveryTicks: 1_000_000,
    },
  );

  /** Ticks (mining an empty block between ticks for depth) until `done`. */
  const until = async (done: () => Promise<boolean>): Promise<boolean> => {
    for (let i = 0; i < 20; i += 1) {
      await engine.tick();
      if (await done()) return true;
      await node.rpc('evm_mine');
    }
    return false;
  };
  const confirmedOp = (id: string) => async () =>
    (await db.prisma.operation.findUniqueOrThrow({ where: { id } })).status === 'confirmed';

  // Both users allowed THROUGH THE BRIDGE: every registry event is a known change.
  for (const u of users) {
    const { change } = await engine.compliance.requestAllow({
      address: u.wallet,
      reason: 'kyc passed (dev)',
      idempotencyKey: randomUUID(),
      requestedBy: 'ops',
    });
    expect(
      await until(
        async () =>
          (await db.prisma.complianceChange.findUniqueOrThrow({ where: { id: change.id } }))
            .status === 'confirmed',
      ),
    ).toBe(true);
    expect(await gateway.readCompliance(u.wallet as `0x${string}`)).toEqual({
      verified: true,
      frozen: false,
    });
  }

  const dep1 = await engine.operations.requestDeposit(alice.id, 1_000_000n, randomUUID());
  expect(await until(confirmedOp(dep1.operation.id))).toBe(true);
  const dep2 = await engine.operations.requestDeposit(bob.id, 250_000n, randomUUID());
  expect(await until(confirmedOp(dep2.operation.id))).toBe(true);
  const tr = await engine.operations.requestTransfer(alice.id, bob.id, 400_000n, randomUUID());
  expect(await until(confirmedOp(tr.operation.id))).toBe(true);
  const wd = await engine.operations.requestWithdrawal(bob.id, 150_000n, randomUUID());
  expect(await until(confirmedOp(wd.operation.id))).toBe(true);
  await engine.tick(); // the index is at the head

  const clean = (await engine.reconciler.reconcileNow()) as ReconciliationRunRecord;
  expect(clean.mismatches).toEqual([]);
  expect(clean.status).toBe('ok');
  expect(clean.finalBlock).toBe((await gateway.getHeadBlock()) - 1n);
  expect(await ledgerHolding(db.prisma, alice)).toBe(600_000n);
  expect(await ledgerHolding(db.prisma, bob)).toBe(500_000n);

  // The admin switches the holder path on and alice moves tokens herself: no bridge reference.
  await setHolderTransfersOnChain(node, bridge, true);
  await holderTransferOnChain(node, bridge, DEV_ROLES.alice, devAddress('bob'), 100_000n);
  await node.rpc('evm_mine'); // final at depth 2
  await engine.tick(); // indexed
  const rogue = (await engine.reconciler.reconcileNow()) as ReconciliationRunRecord;
  expect(rogue.status).toBe('mismatch');
  expect(rogue.mismatches.map((m) => m.kind)).toEqual([
    'unexplained_transfer',
    'balance_mismatch',
    'balance_mismatch',
  ]);
  expect(rogue.mismatches.map((m) => m.detail)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'unexplained_transfer',
        from: alice.wallet,
        to: bob.wallet,
        amount: '100000',
      }),
      { kind: 'balance_mismatch', address: alice.wallet, expected: '600000', observed: '500000' },
      { kind: 'balance_mismatch', address: bob.wallet, expected: '500000', observed: '600000' },
    ]),
  );
  expect(alarms.ofKind('reconciliation_unexplained_transfer')).toHaveLength(1);
  expect(alarms.ofKind('examine_error')).toHaveLength(0);
}, 180_000);
