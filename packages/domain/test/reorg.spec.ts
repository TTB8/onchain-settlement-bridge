import { detectReorg, type Hex, InvalidInputError, nextScanRange, type StoredBlock } from '../src';
import { bh } from './support/fixtures';

/** A hash-linked window of blocks `from..to`, hashes labelled with `fork`. */
function chain(from: number, to: number, fork = 'a'): StoredBlock[] {
  const out: StoredBlock[] = [];
  for (let n = from; n <= to; n += 1) {
    out.push({
      number: BigInt(n),
      hash: bh(`${fork}${n}`),
      parentHash:
        out.length === 0 ? bh(`${fork}${n - 1}`) : (out[out.length - 1] as StoredBlock).hash,
    });
  }
  return out;
}

function canonicalOf(blocks: StoredBlock[]): Map<bigint, Hex> {
  return new Map(blocks.map((b) => [b.number, b.hash]));
}

describe('detectReorg', () => {
  const window = chain(100, 105);

  it('reports nothing for an empty window', () => {
    expect(detectReorg([], new Map())).toEqual({
      reorged: false,
      forkPoint: null,
      rollback: [],
      beyondWindow: false,
    });
  });

  it('reports no reorg when the newest block still matches', () => {
    expect(detectReorg(window, canonicalOf(window))).toEqual({
      reorged: false,
      forkPoint: 105n,
      rollback: [],
      beyondWindow: false,
    });
  });

  it('detects a 1-block reorg', () => {
    const canonical = canonicalOf([...chain(100, 104), ...chain(105, 105, 'b')]);
    expect(detectReorg(window, canonical)).toEqual({
      reorged: true,
      forkPoint: 104n,
      rollback: [105n],
      beyondWindow: false,
    });
  });

  it('detects a deeper reorg inside the window, newest first', () => {
    const canonical = canonicalOf([...chain(100, 101), ...chain(102, 108, 'b')]);
    expect(detectReorg(window, canonical)).toEqual({
      reorged: true,
      forkPoint: 101n,
      rollback: [105n, 104n, 103n, 102n],
      beyondWindow: false,
    });
  });

  it('reports beyondWindow when no stored block matches', () => {
    const canonical = canonicalOf(chain(90, 110, 'b'));
    expect(detectReorg(window, canonical)).toEqual({
      reorged: true,
      forkPoint: null,
      rollback: [105n, 104n, 103n, 102n, 101n, 100n],
      beyondWindow: true,
    });
  });

  it('rolls back heights the chain no longer has (chain shorter than before)', () => {
    const canonical = canonicalOf(chain(100, 103));
    expect(detectReorg(window, canonical)).toEqual({
      reorged: true,
      forkPoint: 103n,
      rollback: [105n, 104n],
      beyondWindow: false,
    });
  });

  it('accepts a lookup function as well as a map', () => {
    const canonical = canonicalOf(chain(100, 104));
    const r = detectReorg(window, (n) => canonical.get(n) ?? null);
    expect(r).toMatchObject({ reorged: true, forkPoint: 104n, rollback: [105n] });
  });

  it('rejects a window that is not contiguous or not hash-linked', () => {
    const gap = [...chain(100, 101), ...chain(103, 104)];
    expect(() => detectReorg(gap, new Map())).toThrow(/contiguous/);
    const broken = chain(100, 102);
    broken[2] = { ...(broken[2] as StoredBlock), parentHash: bh('zzz') };
    expect(() => detectReorg(broken, new Map())).toThrow(InvalidInputError);
  });
});

describe('nextScanRange', () => {
  it('scans forward from just after the last indexed block, capped by batch', () => {
    expect(nextScanRange({ lastIndexed: 99n, head: 1_000n, depth: 12, maxBatch: 100 })).toEqual({
      fromBlock: 100n,
      toBlock: 199n,
    });
  });

  it('never goes beyond head', () => {
    expect(nextScanRange({ lastIndexed: 950n, head: 1_000n, depth: 1, maxBatch: 500 })).toEqual({
      fromBlock: 951n,
      toBlock: 1_000n,
    });
  });

  it('re-scans the unconfirmed tail when caught up', () => {
    // depth 12 at head 1000: blocks 990..1000 have fewer than 12 confirmations.
    expect(nextScanRange({ lastIndexed: 1_000n, head: 1_000n, depth: 12, maxBatch: 100 })).toEqual({
      fromBlock: 990n,
      toBlock: 1_000n,
    });
    expect(nextScanRange({ lastIndexed: 995n, head: 1_000n, depth: 12, maxBatch: 100 })).toEqual({
      fromBlock: 990n,
      toBlock: 1_000n,
    });
  });

  it('returns null when there is nothing to scan (depth 1, caught up)', () => {
    expect(nextScanRange({ lastIndexed: 1_000n, head: 1_000n, depth: 1, maxBatch: 10 })).toBeNull();
  });

  it('starts from block 0 on a young chain and from scratch at lastIndexed -1', () => {
    expect(nextScanRange({ lastIndexed: -1n, head: 3n, depth: 12, maxBatch: 100 })).toEqual({
      fromBlock: 0n,
      toBlock: 3n,
    });
  });

  it('rescans after the chain got shorter than what was indexed', () => {
    expect(nextScanRange({ lastIndexed: 1_010n, head: 1_000n, depth: 3, maxBatch: 10 })).toEqual({
      fromBlock: 999n,
      toBlock: 1_000n,
    });
  });

  it('makes progress to head when the batch is exactly the depth', () => {
    expect(nextScanRange({ lastIndexed: 1_000n, head: 1_000n, depth: 5, maxBatch: 5 })).toEqual({
      fromBlock: 997n,
      toBlock: 1_000n,
    });
  });

  it('rejects bad parameters, including a batch smaller than depth', () => {
    expect(() => nextScanRange({ lastIndexed: 0n, head: 10n, depth: 0, maxBatch: 10 })).toThrow(
      InvalidInputError,
    );
    expect(() => nextScanRange({ lastIndexed: 0n, head: 10n, depth: 12, maxBatch: 11 })).toThrow(
      /maxBatch/,
    );
    expect(() => nextScanRange({ lastIndexed: -2n, head: 10n, depth: 1, maxBatch: 1 })).toThrow(
      InvalidInputError,
    );
    expect(() => nextScanRange({ lastIndexed: 0n, head: -1n, depth: 1, maxBatch: 1 })).toThrow(
      InvalidInputError,
    );
  });
});
