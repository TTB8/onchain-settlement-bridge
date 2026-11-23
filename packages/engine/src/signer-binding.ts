/**
 * @file The signer-binding check (review M-1): the address the gateway signs with must be the one
 * recorded in `signer_state` for the operation's deployment, before any nonce is read or anything
 * is signed. Why: a nonce sequence belongs to an address. With a rotated or misconfigured key the
 * engine would read another account's nonces (every attempt of ours looks "free", so a reversal
 * looks safe) and would sign transactions the contract rejects.
 */

import type { ChainGateway } from '@bridge/chain';
import type { PrismaClient } from '@bridge/db';

import { SignerMismatchError } from './errors';

/**
 * Throws `SignerMismatchError` (after `onMismatch`) unless the gateway's settlement signer is the
 * address recorded in `signer_state` for the deployment (review M-1).
 *
 * @param prisma The database.
 * @param gateway The gateway.
 * @param deploymentId The deployment.
 * @param onMismatch Called with a description before throwing (raise the alarm here).
 */
export async function assertSignerBound(
  prisma: PrismaClient,
  gateway: ChainGateway,
  deploymentId: string,
  onMismatch: (detail: string) => void,
): Promise<void> {
  const row = await prisma.signerState.findUnique({
    where: { deploymentId_signer: { deploymentId, signer: 'settlement' } },
  });
  const ours = gateway.signerAddress('settlement').toLowerCase();
  if (row === null || row.address !== ours) {
    const detail =
      row === null
        ? `deployment ${deploymentId} has no settlement signer row`
        : `gateway signs as ${ours}, deployment ${deploymentId} records ${row.address}`;
    onMismatch(detail);
    throw new SignerMismatchError(detail);
  }
}
