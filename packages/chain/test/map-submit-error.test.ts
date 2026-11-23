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
  makeRedactor,
  mapSubmitError,
  redactUrls,
  safeCause,
  sanitizeError,
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
      'submit: this node refused the submission: intrinsic gas too low',
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

describe('configured-URL redaction (review N-6)', () => {
  const KEY = 'KEYsecret12345';
  const QKEY = 'QUERYsecret678';
  const RPC = `https://rpc.example.invalid:8545/v2/${KEY}?apikey=${QKEY}&x=1`;
  const redact = makeRedactor(RPC);
  const everything = (value: unknown): string => {
    const parts: string[] = [];
    let current: unknown = value;
    for (let depth = 0; current && depth < 12; depth += 1) {
      parts.push(String(current), inspect(current, { depth: 8, showHidden: true }));
      if (current instanceof Error) parts.push(current.stack ?? '', JSON.stringify(current));
      current = (current as { cause?: unknown }).cause;
    }
    return parts.join('\n');
  };
  const forms: [string, string][] = [
    ['scheme-less host:port and path', `nonce too high at rpc.example.invalid:8545/v2/${KEY}`],
    ['scheme-less host and path', `nonce too high at rpc.example.invalid/v2/${KEY}`],
    [
      'JSON-escaped',
      `nonce too high: {"url":"https:\\/\\/rpc.example.invalid:8545\\/v2\\/${KEY}"}`,
    ],
    ['percent-encoded', `nonce too high, upstream=${encodeURIComponent(RPC)}`],
    ['query value alone', `nonce too high (apikey=${QKEY})`],
    ['path segment alone', `nonce too high for key ${KEY.toLowerCase()}`],
  ];

  it.each(forms)('the raw viem error leaks the %s form (not vacuous)', (_name, message) => {
    const raw = everything(rpcError(message));
    expect(
      raw.includes(KEY) || raw.includes(QKEY) || raw.toLowerCase().includes(KEY.toLowerCase()),
    ).toBe(true);
  });

  it('without the configured redactor, the scheme-less form leaks into the message', () => {
    const generic = mapSubmitError(rpcError(forms[0]![1]));
    expect(generic.message).toContain(KEY);
  });

  it.each(forms)(
    'no %s form survives in message, stack, cause chain, inspect or JSON',
    (_name, message) => {
      const mapped = mapSubmitError(rpcError(message), HASH, redact);
      expect(mapped).toBeInstanceOf(SubmissionRejectedError); // "nonce too high" is allowlisted
      expect(mapped.message).toMatch(/^submit: this node refused the submission: nonce too high/);
      const text = everything(mapped).toLowerCase();
      expect(text).not.toContain(KEY.toLowerCase());
      expect(text).not.toContain(QKEY.toLowerCase());
      expect(text).not.toContain('rpc.example.invalid');
    },
  );

  it('also scrubs unknown-outcome and transport errors, and ChainErrors passed through', () => {
    const unknown = mapSubmitError(
      rpcError(`header not found at rpc.example.invalid/v2/${KEY}`, -32603),
      HASH,
      redact,
    );
    expect(unknown).toBeInstanceOf(ChainUnavailableError);
    const transport = mapSubmitError(
      new HttpRequestError({ url: RPC, details: `upstream rpc.example.invalid/v2/${KEY} down` }),
      HASH,
      redact,
    );
    const own = mapSubmitError(new NonceTooLowError(`ours mentions ${KEY}`), HASH, redact);
    for (const error of [unknown, transport, own]) {
      expect(everything(error)).not.toContain(KEY);
    }
  });

  it('the generic pattern catches escaped and percent-encoded URLs it was not configured with', () => {
    expect(redactUrls('x https:\\/\\/other.example\\/k\\/SECRETZ y')).toBe('x <redacted-url> y');
    expect(redactUrls(`x ${encodeURIComponent('https://other.example/k/SECRETZ')} y`)).toBe(
      'x <redacted-url> y',
    );
    expect(redactUrls('x HTTPS%3a%2f%2fother.example%2fSECRETZ y')).toBe('x <redacted-url> y');
  });

  it('a base64 key with + / = is removed in its JSON-escaped and percent-encoded forms', () => {
    // The key as configured is percent-encoded in the URL; nodes may echo it decoded, decoded and
    // JSON-escaped, or encoded. Only the escaped and encoded variants catch the last two.
    const b64 = 'Zm9vYmFy+YmF6/cXV4==';
    const redactB64 = makeRedactor(`https://h.example/v2?token=${encodeURIComponent(b64)}`);
    for (const echoed of [b64, b64.replace(/\//g, '\\/'), encodeURIComponent(b64)]) {
      const out = redactB64(`nonce too high (${echoed})`);
      expect(out).not.toContain('Zm9vYmFy');
      expect(out).not.toContain('cXV4');
    }
  });

  it('a stack read before sanitising (as a logger would) is still redacted', () => {
    const own = new NonceTooLowError(`ours mentions ${KEY}`);
    expect(own.stack).toContain(KEY); // reading it fixes the header line with the raw message
    const mapped = mapSubmitError(own, HASH, redact);
    expect(mapped.stack).not.toContain(KEY);
    expect(mapped.message).not.toContain(KEY);
  });

  it('makeRedactor handles an unparseable URL, no URL, and short pieces', () => {
    expect(makeRedactor('not a url but secret-ish')('x not a url but secret-ish y')).toBe(
      'x <redacted> y',
    );
    expect(makeRedactor()('nothing https://a.b/c here')).toBe('nothing <redacted-url> here');
    // Pieces shorter than four characters ("v2", "x", "1") are left alone.
    expect(redact('v2 x 1')).toBe('v2 x 1');
    const creds = makeRedactor('https://user1:pa%24%24word@h.example/p');
    expect(creds('auth user1 pa$$word')).toBe('auth <redacted> <redacted>');
  });

  it('sanitizeError rewrites message and stack along the whole cause chain', () => {
    const inner = new Error(`inner ${KEY}`);
    const outer = new ChainError(`outer ${KEY}`, inner);
    sanitizeError(outer, redact);
    expect(everything(outer)).not.toContain(KEY);
    expect(sanitizeError('not an error', redact)).toBe('not an error');
  });
});
