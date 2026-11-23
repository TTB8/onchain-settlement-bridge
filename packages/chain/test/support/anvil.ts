/**
 * Spawns a native `anvil` per test file on a free port, deploys the two contracts from the forge
 * build artifacts with the dev accounts, and grants the roles exactly as
 * `contracts/script/Deploy.s.sol` does. Always call `stop()` in `afterAll`.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  stringToHex,
  type Abi,
  type HDAccount,
  type Hex,
  type PublicClient,
} from 'viem';

import {
  complianceRegistryAbi,
  settlementTokenAbi,
  ViemChainGateway,
  type Address,
  type ChainGateway,
  type Receipt,
  type TxHash,
} from '../../src';
import { DEV_ROLES, devAccount } from './dev-accounts';

const CONTRACTS_DIR = resolve(__dirname, '..', '..', '..', '..', 'contracts');

/** Finds a Foundry binary on PATH, or in Foundry's default install folder. */
export function foundryBinary(name: 'anvil' | 'forge'): string {
  try {
    execFileSync(name, ['--version'], { stdio: 'ignore' });
    return name;
  } catch {
    const fallback = join(homedir(), '.foundry', 'bin', name);
    if (existsSync(fallback)) return fallback;
    throw new Error(`${name} is not installed: the chain integration tests need Foundry on PATH`);
  }
}

/** A free TCP port on localhost. */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

/** A running anvil. */
export interface AnvilNode {
  url: string;
  port: number;
  client: PublicClient;
  /** Raw JSON-RPC, for anvil's cheat methods. */
  rpc<T = unknown>(method: string, params?: unknown[]): Promise<T>;
  stop(): Promise<void>;
}

/** Starts anvil on a free port and waits until it answers. */
export async function startAnvil(extraArgs: string[] = []): Promise<AnvilNode> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(
    foundryBinary('anvil'),
    ['--port', String(port), '--host', '127.0.0.1', '--silent', ...extraArgs],
    { stdio: 'ignore' },
  );
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  // Safety net: if the test worker exits without running afterAll (a crashed suite), take anvil
  // down with it instead of leaving an orphan holding a port.
  const killOnExit = () => {
    if (child.exitCode === null) child.kill('SIGKILL');
  };
  process.once('exit', killOnExit);

  const rpc = async <T>(method: string, params: unknown[] = []): Promise<T> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = (await response.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result as T;
  };

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await rpc('eth_chainId');
      break;
    } catch (error) {
      if (child.exitCode !== null || Date.now() > deadline) {
        child.kill('SIGKILL');
        throw new Error(`anvil did not start on port ${port}: ${String(error)}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  return {
    url,
    port,
    client: createPublicClient({ transport: http(url, { retryCount: 0 }) }),
    rpc,
    stop: async () => {
      process.removeListener('exit', killOnExit);
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    },
  };
}

/** The forge build artifact of a contract, building once if `contracts/out` is missing it. */
function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const path = join(CONTRACTS_DIR, 'out', `${name}.sol`, `${name}.json`);
  if (!existsSync(path)) {
    execFileSync(foundryBinary('forge'), ['build'], { cwd: CONTRACTS_DIR, stdio: 'ignore' });
  }
  const json = JSON.parse(readFileSync(path, 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: json.abi, bytecode: json.bytecode.object };
}

/** Addresses of a fresh deployment. */
export interface Deployment {
  registry: Address;
  token: Address;
}

const role = (name: string): Hex => keccak256(stringToHex(name));

/**
 * Waits until a transaction has a receipt. Anvil's automine answers `eth_sendRawTransaction`
 * before the block is sealed, so a receipt read straight after a submit can race it.
 */
export async function waitForReceipt(
  gateway: ChainGateway,
  hash: TxHash,
  timeoutMs = 10_000,
): Promise<Receipt> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const receipt = await gateway.getReceipt(hash);
    if (receipt) return receipt;
    if (Date.now() > deadline) throw new Error(`no receipt for ${hash} after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Waits for a receipt through a raw viem client (setup transactions). */
function waitRaw(node: AnvilNode, hash: Hex) {
  return node.client.waitForTransactionReceipt({ hash, pollingInterval: 20, timeout: 10_000 });
}

/** Sends one transaction from a dev account and waits for its receipt (automine must be on). */
async function sendAndWait(
  node: AnvilNode,
  account: HDAccount,
  tx: { to?: Address; abi: Abi; functionName: string; args: unknown[] },
): Promise<void> {
  const wallet = createWalletClient({ account, transport: http(node.url, { retryCount: 0 }) });
  const hash = await wallet.writeContract({
    chain: null,
    address: tx.to as Address,
    abi: tx.abi,
    functionName: tx.functionName,
    args: tx.args,
  });
  const receipt = await waitRaw(node, hash);
  if (receipt.status !== 'success') throw new Error(`${tx.functionName} reverted during setup`);
}

/** Deploys the registry and the token from the forge artifacts and wires the roles. */
export async function deployBridge(node: AnvilNode): Promise<Deployment> {
  const deployer = devAccount(DEV_ROLES.deployer);
  const wallet = createWalletClient({
    account: deployer,
    transport: http(node.url, { retryCount: 0 }),
  });

  const registryArtifact = artifact('ComplianceRegistry');
  const registryHash = await wallet.deployContract({
    chain: null,
    abi: registryArtifact.abi,
    bytecode: registryArtifact.bytecode,
    args: [deployer.address],
  });
  const registry = (await waitRaw(node, registryHash)).contractAddress as Address;

  const tokenArtifact = artifact('SettlementToken');
  const tokenHash = await wallet.deployContract({
    chain: null,
    abi: tokenArtifact.abi,
    bytecode: tokenArtifact.bytecode,
    args: ['Settlement Token', 'STK', registry, deployer.address],
  });
  const token = (await waitRaw(node, tokenHash)).contractAddress as Address;

  const grant = (to: Address, abi: Abi, roleName: string, index: number) =>
    sendAndWait(node, deployer, {
      to,
      abi,
      functionName: 'grantRole',
      args: [role(roleName), devAccount(index).address],
    });
  await grant(registry, complianceRegistryAbi, 'COMPLIANCE_ROLE', DEV_ROLES.compliance);
  await grant(token, settlementTokenAbi, 'MINTER_ROLE', DEV_ROLES.settlement);
  await grant(token, settlementTokenAbi, 'SETTLER_ROLE', DEV_ROLES.settlement);
  await grant(token, settlementTokenAbi, 'PAUSER_ROLE', DEV_ROLES.pauser);

  return { registry: registry.toLowerCase() as Address, token: token.toLowerCase() as Address };
}

/** A gateway for the deployment, signing with the dev settlement and compliance accounts. */
export function gatewayFor(
  node: AnvilNode,
  deployment: Deployment,
  overrides: Partial<ConstructorParameters<typeof ViemChainGateway>[0]> = {},
): ViemChainGateway {
  return new ViemChainGateway({
    rpcUrl: node.url,
    chainId: 31337,
    registryAddress: deployment.registry,
    tokenAddress: deployment.token,
    signers: {
      settlement: devAccount(DEV_ROLES.settlement),
      compliance: devAccount(DEV_ROLES.compliance),
    },
    ...overrides,
  });
}

/** The pauser pauses or unpauses the token and waits for it to be mined (automine on). */
export async function setPausedOnChain(
  node: AnvilNode,
  deployment: Deployment,
  paused: boolean,
): Promise<Hex> {
  const wallet = createWalletClient({
    account: devAccount(DEV_ROLES.pauser),
    transport: http(node.url, { retryCount: 0 }),
  });
  const hash = await wallet.writeContract({
    chain: null,
    address: deployment.token,
    abi: settlementTokenAbi,
    functionName: paused ? 'pause' : 'unpause',
    gas: 100_000n,
  });
  await waitRaw(node, hash);
  return hash;
}

/** A holder signs a plain ERC-20 transfer outside the bridge and waits for it (automine on). */
export async function holderTransferOnChain(
  node: AnvilNode,
  deployment: Deployment,
  fromIndex: number,
  to: Address,
  amount: bigint,
): Promise<Hex> {
  const wallet = createWalletClient({
    account: devAccount(fromIndex),
    transport: http(node.url, { retryCount: 0 }),
  });
  const hash = await wallet.writeContract({
    chain: null,
    address: deployment.token,
    abi: settlementTokenAbi,
    functionName: 'transfer',
    args: [to, amount],
    gas: 150_000n,
  });
  await waitRaw(node, hash);
  return hash;
}
