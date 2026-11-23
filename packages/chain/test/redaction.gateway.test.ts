/**
 * Review N-6, end to end: a stub JSON-RPC node (plain `node:http`, no chain) answers every call
 * with an error that quotes the gateway's own RPC URL, in the forms a real node, proxy or
 * provider might use: without a scheme, JSON-escaped, percent-encoded, a query value alone, and
 * as an HTTP 502 body. No error the gateway throws may contain the key, the query value or the
 * host, in its message, stack, cause chain, `inspect(showHidden)` or JSON.
 */

import { createServer, type Server } from 'node:http';
import { inspect } from 'node:util';

import { createPublicClient, http } from 'viem';

import { ChainError, ViemChainGateway } from '../src';
import { devAccount } from './support/dev-accounts';
import { ref } from './support/refs';

const KEY = 'KEYsecret12345';
const QKEY = 'QUERYsecret678';
const REGISTRY = '0x00000000000000000000000000000000000000aa';
const TOKEN = '0x00000000000000000000000000000000000000bb';

let server: Server;
let rpcUrl: string;
let hostPort: string;

/** The message the stub sends back for each method: each one quotes the URL differently. */
function leakFor(method: string): string {
  switch (method) {
    case 'eth_blockNumber':
      return `header not found at ${hostPort}/v2/${KEY}`; // scheme-less
    case 'eth_call':
      return `upstream {"url":"${rpcUrl.replace(/\//g, '\\/')}"} failed`; // JSON-escaped
    case 'eth_getTransactionCount':
      return `bad gateway for ${encodeURIComponent(rpcUrl)}`; // percent-encoded
    case 'eth_sendRawTransaction':
      return `nonce too high at ${hostPort}/v2/${KEY}`; // allowlisted rejection, scheme-less
    case 'eth_getBlockByNumber':
      return `quota exceeded for apikey=${QKEY}`; // query value alone
    default:
      return 'unknown';
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      if (method === 'eth_chainId') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result: '0x7a69' }));
        return;
      }
      if (method === 'eth_getTransactionByHash') {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`502 from proxy in front of ${rpcUrl}`); // an HTTP error body
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: leakFor(method) } }),
      );
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  hostPort = `127.0.0.1:${port}`;
  rpcUrl = `http://${hostPort}/v2/${KEY}?apikey=${QKEY}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

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

function gateway(): ViemChainGateway {
  return new ViemChainGateway({
    rpcUrl,
    chainId: 31337,
    registryAddress: REGISTRY,
    tokenAddress: TOKEN,
    signers: { settlement: devAccount(1), compliance: devAccount(2) },
    timeoutMs: 5_000,
  });
}

async function failures(gw: ViemChainGateway): Promise<unknown[]> {
  const calls: Array<Promise<unknown>> = [
    gw.getHeadBlock(),
    gw.readBalance(TOKEN),
    gw.getNonce('settlement'),
    gw.estimateFees(),
    gw.getTransaction(`0x${'ab'.repeat(32)}`),
    gw.submit({
      signer: 'settlement',
      call: { kind: 'mint', to: TOKEN, amount: 1n, ref: ref(1) },
      nonce: 0,
      fees: { maxFeePerGas: 10n, maxPriorityFeePerGas: 1n },
    }),
  ];
  return Promise.all(
    calls.map((p) =>
      p.then(
        () => new Error('unexpected success'),
        (e) => e,
      ),
    ),
  );
}

describe('the gateway never throws its RPC URL, in any form (review N-6)', () => {
  it('the stub really leaks: viem errors for the same calls contain the secrets', async () => {
    const raw = createPublicClient({ transport: http(rpcUrl, { retryCount: 0 }) });
    const errors = await Promise.all(
      [
        raw.getBlockNumber({ cacheTime: 0 }),
        raw.request({ method: 'eth_getTransactionCount', params: [TOKEN, 'latest'] } as never),
        raw.request({ method: 'eth_sendRawTransaction', params: ['0x00'] } as never),
        raw.request({ method: 'eth_getBlockByNumber', params: ['latest', false] } as never),
      ].map((p) =>
        p.then(
          () => null,
          (e: unknown) => e,
        ),
      ),
    );
    for (const error of errors) {
      const text = everything(error);
      expect(text.includes(KEY) || text.includes(QKEY)).toBe(true);
    }
  });

  it('every gateway method fails with a ChainError that carries none of them', async () => {
    const results = await failures(gateway());
    for (const error of results) {
      expect(error).toBeInstanceOf(ChainError);
      const text = everything(error);
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(QKEY);
      expect(text).not.toContain(hostPort);
      expect(text).not.toContain(encodeURIComponent(KEY));
    }
    // The allowlisted rejection still says what the node said, minus the URL.
    const submitError = results[results.length - 1] as Error;
    expect(submitError.message).toMatch(
      /this node refused the submission: nonce too high at <redacted>/,
    );
  });

  it('the gateway object itself shows no URL in inspect or JSON', () => {
    const gw = gateway();
    const text = `${inspect(gw, { depth: 10, showHidden: true })} ${JSON.stringify(gw)}`;
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(QKEY);
  });
});
