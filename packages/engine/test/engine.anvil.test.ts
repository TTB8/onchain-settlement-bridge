/**
 * The whole engine against a REAL chain: a native `anvil` spawned for this file on a free port
 * (stopped in afterAll), the real contracts deployed from the forge artifacts, the real
 * `ViemChainGateway`, and Postgres. deposit -> transfer -> withdrawal through `tick()`, ending
 * balanced: for every user, ledger available + held equals the on-chain balance.
 *
 * DEV ONLY: the only keys are Anvil's public development accounts, derived at runtime from the
 * public test mnemonic by the chain package's test support (never written down, worthless on any
 * real network). The gateway signs locally (`signTransaction`) and the engine checks the REAL
 * EIP-1559 bytes with `ViemTransactionInspector` (decoded, sender recovered) before storing them,
 * then broadcasts exactly those bytes (`sendRaw`).
 */

import { randomUUID } from 'node:crypto';

import { AlarmLog, BridgeEngine, ViemTransactionInspector } from '../src';
import {
  type AnvilNode,
  deployBridge,
  type Deployment,
  gatewayFor,
  startAnvil,
} from '../../chain/test/support/anvil';
import { devAddress } from '../../chain/test/support/dev-accounts';
import { createTestDatabase, type TestDatabase } from './support/database';
import { FakeClock, RecordingIds, type TestUser } from './support/fixtures';
import { ledgerHolding, ref32 } from './support/bridge';

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

it('deposit -> transfer -> withdrawal through tick() on Anvil: every user balanced against the chain', async () => {
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

  // Two users whose wallets are dev accounts, verified on the registry by the compliance signer.
  const users: TestUser[] = [];
  for (const role of ['alice', 'bob'] as const) {
    const wallet = devAddress(role);
    const u = await db.prisma.user.create({ data: { walletAddress: wallet, verified: true } });
    const make = async (kind: 'user_available' | 'user_held' | 'user_incoming') =>
      (await db.prisma.account.create({ data: { kind, userId: u.id } })).id;
    users.push({
      id: u.id,
      wallet,
      available: await make('user_available'),
      held: await make('user_held'),
      incoming: await make('user_incoming'),
    });
    const { pending } = await gateway.getNonce('compliance');
    await gateway.submit({
      signer: 'compliance',
      call: { kind: 'setVerified', account: wallet, verified: true, ref: ref32() },
      nonce: pending,
      fees: await gateway.estimateFees(),
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
      workerId: 'anvil-worker',
      confirmationDepth: 2,
      feeCap: 10n ** 12n,
      lockTimeoutMs: 60_000,
      handlerTimeoutMs: 20_000,
    },
  );

  /** Ticks (mining an empty block between ticks for depth) until the operation is final. */
  const settle = async (operationId: string): Promise<string> => {
    for (let i = 0; i < 20; i += 1) {
      await engine.tick();
      const op = await db.prisma.operation.findUniqueOrThrow({ where: { id: operationId } });
      if (op.status === 'confirmed' || op.status === 'reversed') return op.status;
      await node.rpc('evm_mine');
    }
    return 'not settled';
  };

  const dep1 = await engine.operations.requestDeposit(alice.id, 1_000_000n, randomUUID());
  expect(await settle(dep1.operation.id)).toBe('confirmed');
  const dep2 = await engine.operations.requestDeposit(bob.id, 250_000n, randomUUID());
  expect(await settle(dep2.operation.id)).toBe('confirmed');
  const tr = await engine.operations.requestTransfer(alice.id, bob.id, 400_000n, randomUUID());
  expect(await settle(tr.operation.id)).toBe('confirmed');
  const wd = await engine.operations.requestWithdrawal(bob.id, 150_000n, randomUUID());
  expect(await settle(wd.operation.id)).toBe('confirmed');

  for (const u of users) {
    expect(await ledgerHolding(db.prisma, u)).toBe(
      await gateway.readBalance(u.wallet as `0x${string}`),
    );
  }
  expect(await ledgerHolding(db.prisma, alice)).toBe(600_000n);
  expect(await ledgerHolding(db.prisma, bob)).toBe(500_000n);
  // One attempt per operation, each with the hash the node reported.
  const attempts = await db.prisma.chainAttempt.findMany({ where: { deploymentId: d.id } });
  expect(attempts).toHaveLength(4);
  for (const a of attempts) {
    const receipt = await gateway.getReceipt(a.hash as `0x${string}`);
    expect(receipt?.status).toBe('success');
  }
  expect(alarms.ofKind('examine_error')).toHaveLength(0);
}, 120_000);
