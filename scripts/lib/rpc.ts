/**
 * @file A minimal JSON-RPC client for the local scripts (`setup:local`, `demo`): plain `fetch`, no
 * chain library, so the scripts run from the repository root without their own dependencies.
 *
 * Only what the scripts need: chain id, head, block hash, code, an ERC-20 `balanceOf`, a raw
 * `eth_call`, Anvil's `anvil_mine`, and `eth_sendTransaction` from an account the node holds
 * unlocked (Anvil's dev accounts). Error messages never contain the URL (a hosted RPC URL can
 * carry an API key); they name the method only.
 */

/** A 0x-prefixed hex string. */
export type Hex = `0x${string}`;

/** A JSON-RPC error, or a node that did not answer; the message never contains the URL. */
export class RpcError extends Error {
  /**
   * @param method The JSON-RPC method.
   * @param why What went wrong (no URL).
   */
  constructor(
    readonly method: string,
    why: string,
  ) {
    super(`${method}: ${why}`);
    this.name = 'RpcError';
  }
}

/**
 * ABI selectors of the token functions the scripts call. Hard-coded so the scripts need no
 * keccak implementation; `e2e/test/scripts.unit.test.ts` recomputes each one with viem.
 */
export const SELECTORS = {
  /** `balanceOf(address)` */
  balanceOf: '0x70a08231',
  /** `totalSupply()` */
  totalSupply: '0x18160ddd',
  /** `mint(address,uint256,bytes32)` */
  mint: '0x1e458bee',
} as const;

/**
 * ABI-encodes one static word: an address (left-padded) or a non-negative integer.
 *
 * @param value An address (0x + 40 hex) or a bigint.
 */
export function word(value: string | bigint): string {
  if (typeof value === 'bigint') {
    if (value < 0n || value >= 2n ** 256n) throw new RangeError('word: out of uint256 range');
    return value.toString(16).padStart(64, '0');
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new TypeError('word: not an address or a bytes32');
  }
  return value.slice(2).toLowerCase().padStart(64, '0');
}

/**
 * Calldata: a selector followed by static words.
 *
 * @param selector The 4-byte selector.
 * @param args The arguments.
 */
export function calldata(selector: string, ...args: (string | bigint)[]): Hex {
  return `${selector}${args.map(word).join('')}` as Hex;
}

/** A JSON-RPC client on one URL. */
export class Rpc {
  /**
   * @param url The node URL (never printed).
   * @param timeoutMs Per request.
   */
  constructor(
    private readonly url: string,
    private readonly timeoutMs = 5_000,
  ) {}

  /**
   * One JSON-RPC call.
   *
   * @param method The method.
   * @param params The parameters.
   */
  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    let body: { result?: T; error?: { message?: string } };
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      body = (await res.json()) as typeof body;
    } catch (err) {
      throw new RpcError(method, `no answer (${err instanceof Error ? err.name : 'error'})`);
    }
    if (body.error) throw new RpcError(method, String(body.error.message ?? 'error'));
    if (!('result' in body)) throw new RpcError(method, 'no result');
    return body.result as T;
  }

  /** The node's chain id. */
  async chainId(): Promise<number> {
    return Number(BigInt(await this.call<string>('eth_chainId')));
  }

  /** The head block number. */
  async blockNumber(): Promise<bigint> {
    return BigInt(await this.call<string>('eth_blockNumber'));
  }

  /**
   * The hash of a block, or null when the node does not have it.
   *
   * @param number The block number.
   */
  async blockHash(number: bigint): Promise<string | null> {
    const block = await this.call<{ hash?: string } | null>('eth_getBlockByNumber', [
      `0x${number.toString(16)}`,
      false,
    ]);
    return block?.hash?.toLowerCase() ?? null;
  }

  /**
   * Whether an address has contract code at the head.
   *
   * @param address The address.
   */
  async hasCode(address: string): Promise<boolean> {
    const code = await this.call<string>('eth_getCode', [address, 'latest']);
    return typeof code === 'string' && code !== '0x' && code !== '0x0';
  }

  /**
   * A read-only call at the head.
   *
   * @param to The contract.
   * @param data The calldata.
   */
  ethCall(to: string, data: Hex): Promise<Hex> {
    return this.call<Hex>('eth_call', [{ to, data }, 'latest']);
  }

  /**
   * An ERC-20 balance at the head.
   *
   * @param token The token.
   * @param holder The holder.
   */
  async balanceOf(token: string, holder: string): Promise<bigint> {
    return BigInt(await this.ethCall(token, calldata(SELECTORS.balanceOf, holder)));
  }

  /**
   * Anvil only: mines `blocks` empty blocks.
   *
   * @param blocks How many.
   */
  async mine(blocks: number): Promise<void> {
    await this.call('anvil_mine', [`0x${blocks.toString(16)}`]);
  }

  /** The accounts the node holds unlocked (Anvil's dev accounts), lowercase. */
  async accounts(): Promise<string[]> {
    return (await this.call<string[]>('eth_accounts')).map((a) => a.toLowerCase());
  }

  /**
   * Sends a transaction from an account the node holds unlocked, waits for its receipt, and
   * returns the hash and whether it succeeded. Local nodes only.
   *
   * @param tx From, to, calldata, gas limit.
   * @param timeoutMs How long to wait for the receipt.
   */
  async sendUnlocked(
    tx: { from: string; to: string; data: Hex; gas?: bigint },
    timeoutMs = 20_000,
  ): Promise<{ hash: Hex; success: boolean; blockNumber: bigint }> {
    const hash = await this.call<Hex>('eth_sendTransaction', [
      {
        from: tx.from,
        to: tx.to,
        data: tx.data,
        gas: `0x${(tx.gas ?? 200_000n).toString(16)}`,
      },
    ]);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const receipt = await this.call<{ status: string; blockNumber: string } | null>(
        'eth_getTransactionReceipt',
        [hash],
      );
      if (receipt) {
        return {
          hash,
          success: receipt.status === '0x1',
          blockNumber: BigInt(receipt.blockNumber),
        };
      }
      if (Date.now() > deadline) throw new RpcError('eth_getTransactionReceipt', 'timed out');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
