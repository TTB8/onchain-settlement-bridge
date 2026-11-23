/**
 * Unit tests for the node-error mapping of the viem gateway, with the error shapes viem produces
 * for geth-style, anvil-style and provider-style nodes. (The anvil test file proves the mapping
 * against a real node; this one covers the wordings anvil does not use.)
 *
 * The mapping fails SAFE: only an allowlist of definite rejections becomes
 * `SubmissionRejectedError`; anything unrecognised is `ChainUnavailableError` (outcome unknown).
 */

import { inspect } from 'node:util';

import { BaseError, HttpRequestError, RpcRequestError, TimeoutError } from 'viem';

import {
  AlreadyKnownError,
  ChainError,
  ChainUnavailableError,
  InsufficientFundsError,
  NonceTooLowError,
  ReplacementUnderpricedError,
  SubmissionRejectedError,
  mapSubmitError,
  redactUrls,
  safeCause,
} from '../src';

const HASH = `0x${'cd'.repeat(32)}` as const;
const SECRET_URL = 'https://rpc.example.invalid/v3/tok3n-in-the-path?apikey=tok3n-in-the-query';

function rpcError(message: string, code = -32000): RpcRequestError {
  return new RpcRequestError({
    body: { method: 'eth_sendRawTransaction' },
    error: { code, message },
    url: SECRET_URL,
  });
}

describe('mapSubmitError: specific answers', () => {
  it.each([
    ['nonce too low', NonceTooLowError],
    ['nonce too low: next nonce 5, tx nonce 4', NonceTooLowError],
    ['Transaction nonce is too low. Try incrementing the nonce.', NonceTooLowError],
    ['NONCE IS TOO LOW', NonceTooLowError],
    ['nonce has already been used', NonceTooLowError],
    ['already known', AlreadyKnownError],
    ['known transaction: 0xabc', AlreadyKnownError],
    ['transaction already imported', AlreadyKnownError],
    ['Transaction is already in the mempool', AlreadyKnownError],
    ['replacement transaction underpriced', ReplacementUnderpricedError],
    ['Replacement Transaction Underpriced', ReplacementUnderpricedError],
    ['insufficient funds for gas * price + value', InsufficientFundsError],
    ['Insufficient funds for gas * price + value', InsufficientFundsError],
  ])('maps "%s"', (message, type) => {
    const mapped = mapSubmitError(rpcError(message), HASH);
    expect(mapped).toBeInstanceOf(type);
    expect(mapped.cause).toBeInstanceOf(Error);
  });

  it('reports the known hash with AlreadyKnownError', () => {
    expect((mapSubmitError(rpcError('already known'), HASH) as AlreadyKnownError).txHash).toBe(
      HASH,
    );
  });
});

describe('mapSubmitError: the allowlist of definite rejections', () => {
  it.each([
    'invalid sender',
    'invalid transaction signature',
    'Invalid Signature',
    'intrinsic gas too low',
    'max fee per gas less than block base fee',
    'fee cap less than block base fee: address 0x..., maxFeePerGas: 1 baseFee: 7',
    'feecap too low',
    'exceeds block gas limit',
    'Transaction gas limit exceeds the block gas limit',
    'invalid chain id for signer',
    'incompatible chain id',
    'nonce too high',
    'max priority fee per gas higher than max fee per gas',
  ])('"%s" is a definite rejection', (message) => {
    expect(mapSubmitError(rpcError(message))).toBeInstanceOf(SubmissionRejectedError);
  });
});

describe('mapSubmitError: anything else is an UNKNOWN outcome', () => {
  it.each([
    ['transaction underpriced', -32000],
    ['header not found', -32000],
    ['Internal error', -32603],
    ['upstream request timed out', -32000],
    ['request failed with status 502 after forwarding', -32603],
    ['rate limit exceeded', 429],
    ['execution reverted', 3],
    ['something nobody has seen before', -32000],
  ])('"%s" (code %d) is ChainUnavailableError', (message, code) => {
    const mapped = mapSubmitError(rpcError(message, code));
    expect(mapped).toBeInstanceOf(ChainUnavailableError);
    expect(mapped.message).toMatch(/outcome is unknown/);
  });

  it('non-viem errors are unknown too, unless they say something specific', () => {
    expect(mapSubmitError('weird')).toBeInstanceOf(ChainUnavailableError);
    expect(mapSubmitError(new Error('socket hang up'))).toBeInstanceOf(ChainUnavailableError);
    expect(mapSubmitError(new Error('nonce too low'))).toBeInstanceOf(NonceTooLowError);
  });

  it('maps transport failures to ChainUnavailableError, even when wrapped', () => {
    const http = new HttpRequestError({ url: SECRET_URL, details: 'fetch failed' });
    expect(mapSubmitError(http)).toBeInstanceOf(ChainUnavailableError);
    expect(mapSubmitError(new TimeoutError({ body: {}, url: SECRET_URL }))).toBeInstanceOf(
      ChainUnavailableError,
    );
    expect(mapSubmitError(new BaseError('outer', { cause: http }))).toBeInstanceOf(
      ChainUnavailableError,
    );
  });

  it('passes our own ChainErrors through unchanged', () => {
    const own = new NonceTooLowError('mine');
    expect(mapSubmitError(own)).toBe(own);
  });

  it('includes the node reason in the message', () => {
    expect(mapSubmitError(rpcError('intrinsic gas too low')).message).toBe(
      'submit: rejected by the node: intrinsic gas too low',
    );
    expect(mapSubmitError(new Error('x')).message).toBe(
      'submit: unrecognised node error, the outcome is unknown',
    );
  });
});

describe('URL scrubbing', () => {
  const everything = (error: unknown): string => {
    const parts: string[] = [];
    let current: unknown = error;
    for (let depth = 0; current && depth < 12; depth += 1) {
      parts.push(String(current), inspect(current, { depth: 6 }));
      if (current instanceof Error) parts.push(current.stack ?? '', JSON.stringify(current));
      current = (current as { cause?: unknown }).cause;
    }
    return parts.join('\n');
  };

  it('the raw viem errors DO carry the URL (so the scrubbing below is not vacuous)', () => {
    expect(everything(rpcError('nonce too low'))).toContain('tok3n-in-the-path');
    expect(
      everything(new HttpRequestError({ url: SECRET_URL, details: 'fetch failed' })),
    ).toContain('tok3n-in-the-path');
  });

  it.each([
    ['nonce too low', -32000],
    ['header not found', -32000],
    ['intrinsic gas too low', -32000],
    [`proxy said: could not reach ${SECRET_URL}`, -32603],
  ])('no URL survives mapping "%s"', (message, code) => {
    const text = everything(mapSubmitError(rpcError(message, code)));
    expect(text).not.toContain('tok3n');
    expect(text).not.toContain('rpc.example.invalid');
  });

  it('no URL survives a transport failure', () => {
    const http = new HttpRequestError({
      url: SECRET_URL,
      details: `fetch failed for ${SECRET_URL}`,
      cause: new Error(`connect ECONNREFUSED ${SECRET_URL}`),
    });
    const text = everything(mapSubmitError(new BaseError('outer', { cause: http })));
    expect(text).not.toContain('tok3n');
  });

  it('safeCause keeps names, codes and node details, and redacts every URL', () => {
    const copy = safeCause(rpcError(`boom at ${SECRET_URL}`, -32603))!;
    expect(copy.name).toBe('RpcRequestError');
    expect((copy as Error & { code?: number }).code).toBe(-32603);
    expect(copy.message).toContain('boom at <redacted-url>');
    expect(safeCause(undefined)).toBeUndefined();
    expect(safeCause('plain')?.message).toBe('plain');
    const own = new ChainError('ours');
    expect(safeCause(own)).toBe(own);
    expect(redactUrls('a ws://x.y/z?k=1 b http://h:1/p c')).toBe(
      'a <redacted-url> b <redacted-url> c',
    );
  });
});
