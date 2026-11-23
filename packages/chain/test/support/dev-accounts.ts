/**
 * DEV-ONLY accounts. These are Anvil's well-known development accounts, derived at runtime from
 * the PUBLIC standard test mnemonic that every Foundry and Hardhat install ships with. They hold
 * no real value on any network and must never be used outside a local test chain. No key is
 * written down anywhere in this repository: each one is derived here, in memory, when a test runs.
 */

import { mnemonicToAccount, type HDAccount } from 'viem/accounts';

import type { Address } from '../../src';

/** The public Anvil/Hardhat development mnemonic. Dev only. */
export const DEV_MNEMONIC = 'test test test test test test test test test test test junk';

/** A dev account by its index in Anvil's default list. */
export function devAccount(index: number): HDAccount {
  return mnemonicToAccount(DEV_MNEMONIC, { addressIndex: index });
}

/** The role each dev account plays in the tests. */
export const DEV_ROLES = {
  deployer: 0,
  settlement: 1,
  compliance: 2,
  pauser: 3,
  alice: 4,
  bob: 5,
  carol: 6,
  dave: 7,
} as const;

/** The lowercase address of a dev account by role. */
export function devAddress(role: keyof typeof DEV_ROLES): Address {
  return devAccount(DEV_ROLES[role]).address.toLowerCase() as Address;
}

/**
 * The raw private key of a dev account, as hex, derived at runtime. Used only to prove that no
 * error message ever contains key material.
 */
export function devPrivateKeyHex(index: number): string {
  const key = devAccount(index).getHdKey().privateKey;
  if (!key) throw new Error('dev account has no private key');
  return Buffer.from(key).toString('hex');
}
