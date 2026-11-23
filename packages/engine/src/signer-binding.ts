/**
 * @file The signer-binding check (review M-1): the address the gateway signs with must be the one
 * recorded in `signer_state` for the operation's deployment, before any nonce is read or anything
 * is signed. Why: a nonce sequence belongs to an address. With a rotated or misconfigured key the
 * engine would read another account's nonces (every attempt of ours looks "free", so a reversal
 * looks safe) and would sign transactions the contract rejects.
 */

import type { Address, ChainGateway, SignerName } from '@bridge/chain';
import type { Deployment, PrismaClient } from '@bridge/db';

import { DeploymentMismatchError, SignerMismatchError } from './errors';
import type { SigningExpectation } from './signing';

/** The deployment a gateway is bound to (from `gateway.deployment()`, lowercase). */
export interface DeploymentBinding {
  /** The chain id. */
  readonly chainId: bigint;
  /** The token address (lowercase hex). */
  readonly tokenAddress: string;
  /** The registry address (lowercase hex). */
  readonly registryAddress: string;
}

/**
 * The gateway's own deployment (review M-2): what it signs for, checks and reads. Local.
 *
 * @param gateway The gateway.
 */
export function bindingOf(gateway: ChainGateway): DeploymentBinding {
  const d = gateway.deployment();
  return {
    chainId: BigInt(d.chainId),
    tokenAddress: d.token.toLowerCase(),
    registryAddress: d.registry.toLowerCase(),
  };
}

/** Whether a deployment row is the binding (chain id, token AND registry, case-insensitive). */
export function isBound(d: Deployment, binding: DeploymentBinding): boolean {
  return (
    d.chainId === binding.chainId &&
    d.tokenAddress.toLowerCase() === binding.tokenAddress &&
    d.registryAddress.toLowerCase() === binding.registryAddress
  );
}

/** Throws `DeploymentMismatchError` unless `d` is the bound deployment. */
export function assertBound(d: Deployment, binding: DeploymentBinding): void {
  if (!isBound(d, binding)) {
    throw new DeploymentMismatchError(
      `operation is bound to ${d.tokenAddress} / ${d.registryAddress} on chain ${d.chainId}, ` +
        `but the gateway is bound to ${binding.tokenAddress} / ${binding.registryAddress} ` +
        `on chain ${binding.chainId}`,
    );
  }
}

/**
 * The gateway's deployment row, or null. Found by (chain id, token) and required to match the
 * registry too: a row with another registry is a different deployment (`DeploymentMismatchError`).
 *
 * @param prisma The database.
 * @param binding The gateway's binding.
 */
export async function loadBoundDeployment(
  prisma: PrismaClient,
  binding: DeploymentBinding,
): Promise<Deployment | null> {
  const d = await prisma.deployment.findUnique({
    where: {
      chainId_tokenAddress: { chainId: binding.chainId, tokenAddress: binding.tokenAddress },
    },
  });
  if (d !== null) assertBound(d, binding);
  return d;
}

/**
 * What signed bytes for `d` must say: its chain, contracts and the RECORDED signer address.
 *
 * @param prisma The database.
 * @param d The deployment.
 * @param signer Which signer.
 */
export async function signingExpectationFor(
  prisma: PrismaClient,
  d: Deployment,
  signer: SignerName,
): Promise<SigningExpectation> {
  const row = await prisma.signerState.findUnique({
    where: { deploymentId_signer: { deploymentId: d.id, signer } },
  });
  if (row === null) throw new SignerMismatchError(`deployment ${d.id} has no ${signer} signer row`);
  return {
    chainId: Number(d.chainId),
    token: d.tokenAddress.toLowerCase() as Address,
    registry: d.registryAddress.toLowerCase() as Address,
    signerAddress: row.address as Address,
  };
}

/**
 * Throws `SignerMismatchError` (after `onMismatch`) unless the gateway's address for `signer` is
 * the address recorded in `signer_state` for the deployment (review M-1). The settlement sender
 * checks `settlement`; the compliance sender checks `compliance` (each signer has its own nonce
 * sequence, so a rotated compliance key would make every compliance nonce look free).
 *
 * @param prisma The database.
 * @param gateway The gateway.
 * @param deploymentId The deployment.
 * @param onMismatch Called with a description before throwing (raise the alarm here).
 * @param signer Which signer to check. Default `settlement`.
 */
export async function assertSignerBound(
  prisma: PrismaClient,
  gateway: ChainGateway,
  deploymentId: string,
  onMismatch: (detail: string) => void,
  signer: SignerName = 'settlement',
): Promise<void> {
  const row = await prisma.signerState.findUnique({
    where: { deploymentId_signer: { deploymentId, signer } },
  });
  const ours = gateway.signerAddress(signer).toLowerCase();
  if (row === null || row.address !== ours) {
    const detail =
      row === null
        ? `deployment ${deploymentId} has no ${signer} signer row`
        : `gateway signs ${signer} as ${ours}, deployment ${deploymentId} records ${row.address}`;
    onMismatch(detail);
    throw new SignerMismatchError(detail);
  }
}
