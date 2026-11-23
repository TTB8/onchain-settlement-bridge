/**
 * @file Signing a transaction BEFORE it is sent, and proving the bytes are what was asked for,
 * before anything is stored (ADR 0012 item 1, review M-3).
 *
 * The gateway signs (`signTransaction`, local, no node) and later broadcasts exactly those bytes
 * (`sendRaw`, idempotent for known bytes). Between the two the engine stores `{ hash, raw }` in
 * `chain_attempt`, where they are immutable and rebroadcast after any crash. So the bytes must be
 * checked FIRST: a gateway bug, a misconfigured key or a compromised signer that returns other
 * bytes (another nonce, another recipient, another contract, another key, a hash that is not the
 * bytes' hash) would otherwise be persisted as "our" transaction, and every later decision
 * (`attemptCanStillMine`, receipts by hash, rebroadcasts) would be about the wrong transaction.
 *
 * `signAndVerify` therefore checks, in the engine, before returning:
 * - `keccak256(raw) === hash`;
 * - the decoded transaction (through a `RawTransactionInspector`) is EIP-1559 with the request's
 *   chain id, nonce, both fee fields, the exact call (kind, every argument), sent to the
 *   deployment's contract for that call, and recovers to the deployment's signer address.
 * Any difference is `SignedTransactionMismatchError`: nothing is stored, nothing is sent.
 *
 * The inspector is a port because the fake gateway's bytes are its own canonical encoding, not
 * real EIP-1559 bytes. `ViemTransactionInspector` is the real one (viem `parseTransaction`,
 * `recoverTransactionAddress`, and the contracts' ABIs).
 */

import {
  type Address,
  type ChainGateway,
  complianceRegistryAbi,
  type ContractCall,
  type Hex,
  SIGNER_FOR_CALL,
  type SignedTransaction,
  settlementTokenAbi,
  type SubmitRequest,
} from '@bridge/chain';
import {
  decodeFunctionData,
  encodeFunctionData,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
} from 'viem';

import { SignedTransactionMismatchError } from './errors';

/** What a signed transaction says, decoded from its raw bytes. */
export interface DecodedTransaction {
  /** Only EIP-1559 transactions are ever signed by the bridge. */
  readonly type: 'eip1559';
  /** The chain id the signature commits to. */
  readonly chainId: number;
  /** The nonce. */
  readonly nonce: number;
  /** The contract called (lowercase). */
  readonly to: Address;
  /** The call, decoded from the calldata against the contract's ABI. */
  readonly call: ContractCall;
  /** The fee cap. */
  readonly maxFeePerGas: bigint;
  /** The tip. */
  readonly maxPriorityFeePerGas: bigint;
  /** The address the signature recovers to (lowercase). */
  readonly from: Address;
  /** The ether sent with it (the bridge never sends any). */
  readonly value: bigint;
  /** The gas limit, or null when the encoding carries none (the fake's). */
  readonly gas: bigint | null;
}

/** Decodes signed bytes (and recovers their sender). */
export interface RawTransactionInspector {
  /**
   * Decodes `raw`. Throws when the bytes cannot be decoded (they are then refused).
   *
   * @param raw The signed bytes.
   */
  decode(raw: Hex): Promise<DecodedTransaction>;
}

/** What the signed bytes must say besides the request itself. */
export interface SigningExpectation {
  /** The deployment's chain id. */
  readonly chainId: number;
  /** The deployment's token (target of settlement calls). */
  readonly token: Address;
  /** The deployment's registry (target of compliance calls). */
  readonly registry: Address;
  /** The deployment's recorded address for the request's signer (`signer_state`). */
  readonly signerAddress: Address;
}

const lower = (a: string): Address => a.toLowerCase() as Address;

function sameCall(a: ContractCall, b: ContractCall): boolean {
  const norm = (c: ContractCall): string =>
    JSON.stringify(
      Object.entries(c)
        .map(([k, v]) => [k, typeof v === 'string' ? v.toLowerCase() : String(v)] as const)
        .sort(([x], [y]) => (x < y ? -1 : 1)),
    );
  return norm(a) === norm(b);
}

/**
 * Every field in which `decoded` differs from what `request` and `expected` require. Empty means
 * the bytes are exactly the requested transaction. Pure.
 *
 * @param request What was asked for.
 * @param expected The deployment's chain, contracts and signer.
 * @param decoded What the bytes say.
 */
export function signedTransactionDifferences(
  request: SubmitRequest,
  expected: SigningExpectation,
  decoded: DecodedTransaction,
): string[] {
  const out: string[] = [];
  const contract =
    SIGNER_FOR_CALL[request.call.kind] === 'settlement' ? expected.token : expected.registry;
  if (decoded.type !== 'eip1559') out.push('type');
  if (decoded.chainId !== expected.chainId) out.push('chainId');
  if (decoded.nonce !== request.nonce) out.push('nonce');
  if (lower(decoded.to) !== lower(contract)) out.push('to');
  if (!sameCall(decoded.call, request.call)) out.push('data');
  if (decoded.maxFeePerGas !== request.fees.maxFeePerGas) out.push('maxFeePerGas');
  if (decoded.maxPriorityFeePerGas !== request.fees.maxPriorityFeePerGas) {
    out.push('maxPriorityFeePerGas');
  }
  if (lower(decoded.from) !== lower(expected.signerAddress)) out.push('from');
  if (decoded.value !== 0n) out.push('value');
  // The gas limit is NOT compared (review piece B, quick item): the gateway chooses it, no caller
  // knew it, and a wrong limit can only make the transaction revert out of gas (a receipt the
  // monitor already handles), never move other funds or spend another nonce. `decoded.gas` stays
  // in the decoded view for logs and tests.
  return out;
}

/**
 * Signs `request` with the gateway (nothing sent) and returns the signed transaction only if the
 * bytes hash to the reported hash and decode to exactly the request (see the file comment).
 * Throws `SignedTransactionMismatchError` otherwise, and whatever `signTransaction` throws.
 *
 * @param gateway Signs.
 * @param inspector Decodes the bytes.
 * @param request What to sign.
 * @param expected The deployment's chain, contracts and signer.
 */
export async function signAndVerify(
  gateway: ChainGateway,
  inspector: RawTransactionInspector,
  request: SubmitRequest,
  expected: SigningExpectation,
): Promise<SignedTransaction> {
  const signed = await gateway.signTransaction(request);
  const raw = signed.raw.toLowerCase() as Hex;
  const hash = signed.hash.toLowerCase() as Hex;
  if (keccak256(raw) !== hash) {
    throw new SignedTransactionMismatchError('the signed bytes do not hash to the reported hash');
  }
  let decoded: DecodedTransaction;
  try {
    decoded = await inspector.decode(raw);
  } catch {
    throw new SignedTransactionMismatchError('the signed bytes cannot be decoded');
  }
  const differences = signedTransactionDifferences(request, expected, decoded);
  if (differences.length > 0) {
    throw new SignedTransactionMismatchError(
      `the signed bytes differ from the request in: ${differences.join(', ')}`,
    );
  }
  return { hash, raw };
}

/** The bridge's ABIs, by the contract that carries each call. */
const ABIS = [settlementTokenAbi, complianceRegistryAbi] as const;

function asAddress(v: unknown): Address {
  if (typeof v !== 'string') throw new TypeError('expected an address');
  return lower(v);
}

function asBigint(v: unknown): bigint {
  if (typeof v !== 'bigint') throw new TypeError('expected a uint256');
  return v;
}

function asBool(v: unknown): boolean {
  if (typeof v !== 'boolean') throw new TypeError('expected a bool');
  return v;
}

function asRef(v: unknown): `0x${string}` {
  if (typeof v !== 'string') throw new TypeError('expected bytes32');
  return v.toLowerCase() as `0x${string}`;
}

/**
 * Decodes bridge calldata into a `ContractCall`. Throws for anything else, including calldata with
 * bytes after the encoded arguments (the ABI decoder ignores them; re-encoding shows them).
 */
export function callFromCalldata(data: Hex): ContractCall {
  for (const abi of ABIS) {
    let decoded: { functionName: string; args: readonly unknown[] | undefined };
    try {
      decoded = decodeFunctionData({ abi, data }) as typeof decoded;
    } catch {
      continue;
    }
    const again = encodeFunctionData({
      abi,
      functionName: decoded.functionName,
      args: decoded.args,
    } as Parameters<typeof encodeFunctionData>[0]);
    if (again.toLowerCase() !== data.toLowerCase()) {
      throw new TypeError('calldata carries bytes after the encoded arguments');
    }
    const a = decoded.args ?? [];
    switch (decoded.functionName) {
      case 'mint':
        return { kind: 'mint', to: asAddress(a[0]), amount: asBigint(a[1]), ref: asRef(a[2]) };
      case 'burn':
        return { kind: 'burn', from: asAddress(a[0]), amount: asBigint(a[1]), ref: asRef(a[2]) };
      case 'settleTransfer':
        return {
          kind: 'settleTransfer',
          from: asAddress(a[0]),
          to: asAddress(a[1]),
          amount: asBigint(a[2]),
          ref: asRef(a[3]),
        };
      case 'setVerified':
        return {
          kind: 'setVerified',
          account: asAddress(a[0]),
          verified: asBool(a[1]),
          ref: asRef(a[2]),
        };
      case 'setFrozen':
        return {
          kind: 'setFrozen',
          account: asAddress(a[0]),
          frozen: asBool(a[1]),
          ref: asRef(a[2]),
        };
    }
  }
  throw new TypeError('calldata is not a bridge call');
}

/** The real inspector: EIP-1559 bytes, decoded and sender-recovered with viem. */
export class ViemTransactionInspector implements RawTransactionInspector {
  /** @inheritdoc */
  async decode(raw: Hex): Promise<DecodedTransaction> {
    const tx = parseTransaction(raw);
    if (tx.type !== 'eip1559') throw new TypeError(`not an EIP-1559 transaction: ${tx.type}`);
    if (
      tx.chainId === undefined ||
      tx.nonce === undefined ||
      tx.to === undefined ||
      tx.to === null ||
      tx.data === undefined ||
      tx.maxFeePerGas === undefined ||
      tx.maxPriorityFeePerGas === undefined
    ) {
      throw new TypeError('the transaction is missing a field');
    }
    const from = await recoverTransactionAddress({
      serializedTransaction: raw as Parameters<
        typeof recoverTransactionAddress
      >[0]['serializedTransaction'],
    });
    return {
      type: 'eip1559',
      chainId: tx.chainId,
      nonce: tx.nonce,
      to: lower(tx.to),
      call: callFromCalldata(tx.data),
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      from: lower(from),
      value: tx.value ?? 0n,
      gas: tx.gas ?? null,
    };
  }
}
