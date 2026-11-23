/**
 * @file Shared test fixtures: a seeded PRNG (so property tests are reproducible without a
 * dependency) and helpers for building addresses, hashes and references.
 */

import type { Address, Bytes32, TxHash } from '../../src';

/**
 * mulberry32: a tiny, well-known 32-bit PRNG. Deterministic for a given seed, which is the point:
 * a failing property run prints its seed and can be replayed exactly.
 */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random integer in [0, n). */
export function randInt(rand: () => number, n: number): number {
  return Math.floor(rand() * n);
}

/** A lowercase address made from a single repeated hex digit or a small number. */
export function addr(n: number): Address {
  return `0x${n.toString(16).padStart(40, '0')}`;
}

/** A lowercase 32-byte transaction hash made from a small number. */
export function txh(n: number): TxHash {
  return `0x${n.toString(16).padStart(64, 'f')}`;
}

/** A bridge-style reference (high half zero) made from a small number. */
export function refOf(n: number): Bytes32 {
  return `0x${'0'.repeat(32)}${n.toString(16).padStart(32, '0')}`;
}

/** A block hash made from a label, for reorg tests. */
export function bh(label: string): `0x${string}` {
  return `0x${Buffer.from(label).toString('hex').padEnd(64, '0').slice(0, 64)}`;
}
