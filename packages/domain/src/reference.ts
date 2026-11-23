/**
 * @file The 32-byte on-chain reference that names an off-chain operation, and its link to the
 * operation's UUID.
 *
 * Why a reversible encoding instead of a hash: the contracts consume each reference once, which is
 * what makes a retried submission safe. When the indexer sees a reference on chain it must find the
 * operation without a lookup table, and a person reading a block explorer should be able to recover
 * the operation id by hand. So the 16 UUID bytes are left-padded with 16 zero bytes: the reference
 * IS the UUID, and anything with non-zero high bytes was not made by this bridge.
 */

import { InvalidReferenceError } from './errors';
import { type Bytes32, isBytes32 } from './primitives';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZERO_HIGH_HALF = '0'.repeat(32);
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * The reference for an operation UUID: `0x` + 32 zero hex digits + the 32 UUID hex digits, lowercase.
 * Accepts the canonical 8-4-4-4-12 form in either case. Throws `InvalidReferenceError` for anything
 * else, and for the nil UUID, because the contracts reject the all-zero reference.
 */
export function referenceFromUuid(uuid: string): Bytes32 {
  if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) {
    throw new InvalidReferenceError(`not a canonical UUID: ${String(uuid)}`);
  }
  const lower = uuid.toLowerCase();
  if (lower === NIL_UUID) {
    throw new InvalidReferenceError(
      'the nil UUID maps to the zero reference, which the contracts reject',
    );
  }
  return `0x${ZERO_HIGH_HALF}${lower.replace(/-/g, '')}`;
}

/** True when `value` is a lowercase 32-byte reference that this bridge could have produced. */
export function isReference(value: unknown): value is Bytes32 {
  return (
    isBytes32(value) && value.slice(2, 34) === ZERO_HIGH_HALF && value.slice(34) !== ZERO_HIGH_HALF
  );
}

/**
 * The operation UUID behind a reference (lowercase, hyphenated). Throws `InvalidReferenceError` when
 * the input is not lowercase 32-byte hex, when its high 16 bytes are not zero (not one of ours), or
 * when it is the zero reference.
 */
export function uuidFromReference(ref: string): string {
  if (!isBytes32(ref)) {
    throw new InvalidReferenceError(`not a lowercase 32-byte hex reference: ${String(ref)}`);
  }
  if (ref.slice(2, 34) !== ZERO_HIGH_HALF) {
    throw new InvalidReferenceError(
      `reference ${ref} has non-zero high bytes; it was not made from a UUID`,
    );
  }
  const h = ref.slice(34);
  if (h === ZERO_HIGH_HALF) {
    throw new InvalidReferenceError('the zero reference names no operation');
  }
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
