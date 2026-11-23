/**
 * @file Signing a transaction BEFORE it is sent, so the engine can store its hash and bytes first
 * (ADR 0012 item 1), and broadcasting exactly those bytes afterwards.
 *
 * Why a separate port: `ChainGateway.submit` signs and sends in one call and only reveals the hash
 * afterwards. A crash, a timeout or an unknown answer between "signed" and "recorded" would then
 * leave a transaction on the wire that the database has never heard of, and the reversal check
 * (`anAttemptCanStillMine`) would miss it. The `chain_attempt` row also needs the hash and the raw
 * bytes at INSERT (both are immutable and NOT NULL). So the engine asks a `TransactionSigner` for
 * the signed transaction first, commits it, and only then broadcasts.
 *
 * Production wiring needs the chain package to expose sign-only and send-raw on its gateway (see
 * the engine README, open question). Until then `ResigningSigner` adapts any gateway whose signing
 * is deterministic (both gateways are: RFC 6979 signatures in viem, hash-of-request in the fake):
 * `sign` comes from the caller, `broadcast` re-submits the same request through the gateway and
 * refuses to call it a success unless the gateway reports the very hash that was recorded.
 */

import {
  AlreadyKnownError,
  type ChainGateway,
  type Hex,
  type SubmitRequest,
  type TxHash,
} from '@bridge/chain';

import { SignedHashMismatchError } from './errors';

/** A signed, not yet sent, transaction. */
export interface SignedTransaction {
  /** Its hash, lowercase. */
  readonly hash: TxHash;
  /** The exact bytes to send, lowercase `0x` hex. */
  readonly raw: Hex;
}

/** Signs without sending, and sends exactly what was signed. */
export interface TransactionSigner {
  /**
   * Signs `request` without sending it. Must be deterministic: the same request gives the same
   * bytes and hash, so a rebroadcast after a crash is the same transaction.
   *
   * @param request Signer, call, nonce and fees.
   */
  sign(request: SubmitRequest): Promise<SignedTransaction>;

  /**
   * Sends `signed` (whose request is `request`). Throws the same typed errors as
   * `ChainGateway.submit`; `SignedHashMismatchError` when what was sent is not what was recorded.
   * Returns the hash, which equals `signed.hash`.
   *
   * @param signed The recorded transaction.
   * @param request The request it was signed from.
   */
  broadcast(signed: SignedTransaction, request: SubmitRequest): Promise<TxHash>;
}

/** Signs a request without sending it (supplied by whoever holds the key). */
export type SignFunction = (request: SubmitRequest) => Promise<SignedTransaction>;

/**
 * A `TransactionSigner` for a gateway that signs deterministically: `sign` is the supplied
 * function, `broadcast` re-submits the same request and checks the gateway reports the recorded
 * hash. `AlreadyKnownError` for the recorded hash (or with no hash) counts as sent.
 */
export class ResigningSigner implements TransactionSigner {
  /**
   * @param gateway The gateway that sends.
   * @param signFn Produces the same bytes the gateway will send for a request.
   */
  constructor(
    private readonly gateway: ChainGateway,
    private readonly signFn: SignFunction,
  ) {}

  /** @inheritdoc */
  sign(request: SubmitRequest): Promise<SignedTransaction> {
    return this.signFn(request);
  }

  /** @inheritdoc */
  async broadcast(signed: SignedTransaction, request: SubmitRequest): Promise<TxHash> {
    let hash: TxHash;
    try {
      hash = await this.gateway.submit(request);
    } catch (err) {
      if (err instanceof AlreadyKnownError) {
        // The node already holds a transaction with these bytes: it is the one we recorded,
        // unless the node names a different hash.
        if (err.txHash === undefined || err.txHash.toLowerCase() === signed.hash) {
          return signed.hash;
        }
        throw new SignedHashMismatchError(
          `the node already holds ${err.txHash.toLowerCase()}, not the recorded ${signed.hash}`,
        );
      }
      throw err;
    }
    const sent = hash.toLowerCase() as TxHash;
    if (sent !== signed.hash) {
      throw new SignedHashMismatchError(`sent ${sent}, but the attempt recorded ${signed.hash}`);
    }
    return sent;
  }
}
