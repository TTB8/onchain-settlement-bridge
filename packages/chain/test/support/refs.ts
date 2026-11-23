/** Helpers for single-use references in tests. */

import { toHex } from 'viem';

import type { Bytes32 } from '../../src';

/** A 32-byte reference from a small number (never zero unless asked). */
export function ref(n: number | bigint): Bytes32 {
  return toHex(BigInt(n), { size: 32 });
}

/** The zero reference, which both contracts reject. */
export const ZERO_REF: Bytes32 = ref(0);

/** The zero address. */
export const ZERO_ADDRESS = toHex(0, { size: 20 });
