/**
 * @file The on-chain value shapes the domain speaks: addresses, hashes and 32-byte references.
 *
 * Why the domain defines its own: it must not import the chain package (that would pull in a chain
 * library). These aliases are structurally identical to the chain package's, so values flow between
 * the two without conversion. One canonical spelling (lowercase hex) is enforced so that equality
 * checks in reconciliation are plain string comparisons and can never miss on letter case.
 */

import { InvalidInputError } from './errors';

/** A lowercase `0x`-prefixed 20-byte address. */
export type Address = `0x${string}`;

/** A `0x`-prefixed hex string of any length. */
export type Hex = `0x${string}`;

/** A 32-byte value, as `0x` plus 64 lowercase hex characters. */
export type Bytes32 = `0x${string}`;

/** The hash of a transaction (32 bytes, lowercase hex). */
export type TxHash = `0x${string}`;

/** The zero address: the `from` of a mint and the `to` of a burn in an ERC-20 `Transfer` event. */
export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const BYTES32_RE = /^0x[0-9a-f]{64}$/;

/** True when `value` is a lowercase `0x` address. Mixed-case (checksummed) input is rejected on purpose. */
export function isAddress(value: unknown): value is Address {
  return typeof value === 'string' && ADDRESS_RE.test(value);
}

/** True when `value` is a lowercase `0x` 32-byte hex string (a hash or a reference). */
export function isBytes32(value: unknown): value is Bytes32 {
  return typeof value === 'string' && BYTES32_RE.test(value);
}

/**
 * Throws unless `value` is a lowercase address.
 *
 * @param value The candidate.
 * @param what A label for the error message, such as `transfer.to`.
 */
export function assertAddress(value: unknown, what: string): asserts value is Address {
  if (!isAddress(value)) {
    throw new InvalidInputError(`${what} must be a lowercase 0x address, got ${String(value)}`);
  }
}
