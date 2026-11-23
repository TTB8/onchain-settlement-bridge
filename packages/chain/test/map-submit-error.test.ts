/**
 * Unit tests for the node-error mapping of the viem gateway, with the error shapes viem produces
 * for geth-style and anvil-style nodes. (The anvil test file proves the mapping against a real
 * node; this one covers the wordings anvil does not use.)
 */

import { BaseError, HttpRequestError, RpcRequestError, TimeoutError } from 'viem';

import {
  AlreadyKnownError,
  ChainUnavailableError,
  InsufficientFundsError,
  NonceTooLowError,
  ReplacementUnderpricedError,
  SubmissionRejectedError,
  mapSubmitError,
} from '../src';

const HASH = `0x${'cd'.repeat(32)}` as const;

function rpcError(message: string): RpcRequestError {
  return new RpcRequestError({ body: {}, error: { code: -32000, message }, url: 'http://node' });
}

describe('mapSubmitError', () => {
  it.each([
    ['nonce too low', NonceTooLowError],
    ['nonce too low: next nonce 5, tx nonce 4', NonceTooLowError],
    ['already known', AlreadyKnownError],
    ['known transaction: 0xabc', AlreadyKnownError],
    ['transaction already imported', AlreadyKnownError],
    ['replacement transaction underpriced', ReplacementUnderpricedError],
    ['insufficient funds for gas * price + value', InsufficientFundsError],
    ['Insufficient funds for gas * price + value', InsufficientFundsError],
    ['transaction underpriced', SubmissionRejectedError],
    ['intrinsic gas too low', SubmissionRejectedError],
  ])('maps "%s"', (message, type) => {
    const mapped = mapSubmitError(rpcError(message), HASH);
    expect(mapped).toBeInstanceOf(type);
    expect(mapped.cause).toBeInstanceOf(RpcRequestError);
  });

  it('reports the known hash with AlreadyKnownError', () => {
    expect((mapSubmitError(rpcError('already known'), HASH) as AlreadyKnownError).txHash).toBe(
      HASH,
    );
  });

  it('maps transport failures to ChainUnavailableError, even when wrapped', () => {
    const http = new HttpRequestError({ url: 'http://node', details: 'fetch failed' });
    expect(mapSubmitError(http)).toBeInstanceOf(ChainUnavailableError);
    expect(mapSubmitError(new TimeoutError({ body: {}, url: 'http://node' }))).toBeInstanceOf(
      ChainUnavailableError,
    );
    const wrapped = new BaseError('outer', { cause: http });
    expect(mapSubmitError(wrapped)).toBeInstanceOf(ChainUnavailableError);
  });

  it('maps plain errors by message and passes ChainErrors through', () => {
    expect(mapSubmitError(new Error('nonce too low'))).toBeInstanceOf(NonceTooLowError);
    expect(mapSubmitError('weird')).toBeInstanceOf(SubmissionRejectedError);
    const own = new NonceTooLowError('mine');
    expect(mapSubmitError(own)).toBe(own);
  });

  it('includes the node reason in the message but nothing else from the request', () => {
    const mapped = mapSubmitError(rpcError('intrinsic gas too low'));
    expect(mapped.message).toBe('submit: rejected by the node: intrinsic gas too low');
    expect(mapSubmitError(new Error('x')).message).toBe('submit: rejected by the node');
  });
});
