/**
 * The worker's lifecycle with an injected engine and signal source: startup refusals, the loop,
 * the in-flight tick awaited on shutdown, the shutdown timeout, fatal alarms, the logger.
 */

import { EventEmitter } from 'node:events';

import { DeploymentMismatchError } from '@bridge/engine';

import { FATAL_ALARMS, WorkerAlarmSink, WorkerLogger } from '../src/logger';
import { type EngineLoop, WorkerRunner } from '../src/runner';

class FakeEngine implements EngineLoop {
  started = 0;
  stopped = 0;
  deploymentError: Error | undefined;
  /** Resolves the in-flight tick when called. */
  finishTick: (() => void) | undefined;
  private inFlight: Promise<void> | undefined;

  async assertDeployment(): Promise<void> {
    if (this.deploymentError !== undefined) throw this.deploymentError;
  }

  start(): void {
    this.started += 1;
  }

  /** Pretends a tick is running until `finishTick()`. */
  beginTick(): void {
    this.inFlight = new Promise((resolve) => {
      this.finishTick = resolve;
    });
  }

  async stop(): Promise<void> {
    this.stopped += 1;
    await this.inFlight;
  }
}

function setup(timeoutMs = 1_000, checks?: () => Promise<void>) {
  const engine = new FakeEngine();
  const signals = new EventEmitter();
  const lines: string[] = [];
  const logger = new WorkerLogger({
    level: 'debug',
    secrets: ['sup3r-secret'],
    write: (l) => lines.push(l),
  });
  const runner = new WorkerRunner({
    engine,
    logger,
    shutdownTimeoutMs: timeoutMs,
    signals,
    ...(checks !== undefined ? { checks } : {}),
  });
  const msgs = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { engine, signals, runner, lines, msgs };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('WorkerRunner', () => {
  it('starts the loop, and SIGTERM stops it cleanly with exit code 0', async () => {
    const { engine, signals, runner, msgs } = setup();
    const done = runner.run();
    await flush();
    expect(engine.started).toBe(1);
    expect(signals.listenerCount('SIGTERM')).toBe(1);
    expect(signals.listenerCount('SIGINT')).toBe(1);
    signals.emit('SIGTERM');
    expect(await done).toBe(0);
    expect(engine.stopped).toBe(1);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(msgs().map((m) => m.msg)).toEqual([
      'engine loop started',
      'stopping',
      'engine loop stopped',
    ]);
  });

  it('SIGINT works the same way', async () => {
    const { signals, runner } = setup();
    const done = runner.run();
    await flush();
    signals.emit('SIGINT');
    expect(await done).toBe(0);
  });

  it('waits for the tick in progress before resolving', async () => {
    const { engine, signals, runner } = setup(10_000);
    const done = runner.run();
    await flush();
    engine.beginTick();
    let settled = false;
    void done.then(() => {
      settled = true;
    });
    signals.emit('SIGTERM');
    await flush();
    await flush();
    expect(engine.stopped).toBe(1);
    expect(settled).toBe(false); // still waiting for the tick
    engine.finishTick?.();
    expect(await done).toBe(0);
    expect(settled).toBe(true);
  });

  it('a tick that outlives the shutdown timeout exits 1', async () => {
    jest.useFakeTimers();
    try {
      const { engine, signals, runner, msgs } = setup(5_000);
      const done = runner.run();
      await Promise.resolve();
      await Promise.resolve();
      engine.beginTick();
      signals.emit('SIGTERM');
      await jest.advanceTimersByTimeAsync(5_000);
      expect(await done).toBe(1);
      expect(
        msgs().some((m) => String(m.msg).includes('did not finish within the shutdown timeout')),
      ).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a second signal while stopping is only logged', async () => {
    const { engine, signals, runner, msgs } = setup(10_000);
    const done = runner.run();
    await flush();
    engine.beginTick();
    signals.emit('SIGTERM');
    signals.emit('SIGINT');
    engine.finishTick?.();
    expect(await done).toBe(0);
    expect(msgs().filter((m) => m.msg === 'stop already requested')).toHaveLength(1);
    expect(engine.stopped).toBe(1);
  });

  it('refuses to run (exit 1, loop never started) when the deployment binding does not match', async () => {
    const { engine, runner, msgs } = setup();
    engine.deploymentError = new DeploymentMismatchError(
      'active deployment is 0xabc, the gateway is bound to 0xdef',
    );
    expect(await runner.run()).toBe(1);
    expect(engine.started).toBe(0);
    const line = msgs()[0];
    expect(line?.msg).toBe('refusing to run: the deployment binding does not match');
    expect(String(line?.error)).toContain('DeploymentMismatchError');
  });

  it('refuses to run when an extra startup check fails', async () => {
    const { engine, runner } = setup(1_000, async () => {
      throw new Error('signer mismatch');
    });
    expect(await runner.run()).toBe(1);
    expect(engine.started).toBe(0);
  });

  it('a fatal alarm while running stops the loop with exit code 1', async () => {
    const { engine, runner, msgs } = setup();
    const done = runner.run();
    await flush();
    runner.onFatalAlarm({ kind: 'deployment_mismatch', detail: 'switched', at: new Date() });
    expect(await done).toBe(1);
    expect(engine.stopped).toBe(1);
    expect(msgs().find((m) => m.msg === 'stopping')).toMatchObject({ level: 'error', exitCode: 1 });
  });

  it('a stop requested before run() is honoured without starting the loop', async () => {
    const { engine, runner } = setup();
    runner.requestStop(1, 'early');
    expect(await runner.run()).toBe(1);
    expect(engine.started).toBe(0);
  });

  it('a failing engine.stop() is an unclean exit', async () => {
    const { engine, signals, runner } = setup();
    engine.stop = async () => {
      throw new Error('pool closed');
    };
    const done = runner.run();
    await flush();
    signals.emit('SIGTERM');
    expect(await done).toBe(1);
  });

  it('listens to the process signals by default and detaches afterwards', async () => {
    const before = process.listenerCount('SIGTERM');
    const runner = new WorkerRunner({
      engine: new FakeEngine(),
      logger: new WorkerLogger({ level: 'error', secrets: [], write: () => undefined }),
      shutdownTimeoutMs: 1_000,
    });
    const done = runner.run();
    await flush();
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    runner.requestStop(0, 'test');
    expect(await done).toBe(0);
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
});

describe('WorkerAlarmSink', () => {
  it('logs every alarm redacted; fatal kinds call onFatal, others do not; never throws', () => {
    const lines: string[] = [];
    const sink = new WorkerAlarmSink(
      new WorkerLogger({ level: 'log', secrets: ['sup3r-secret'], write: (l) => lines.push(l) }),
    );
    const fatal: string[] = [];
    sink.onFatal = (a) => fatal.push(a.kind);
    const at = new Date(Date.UTC(2026, 10, 23));
    sink.raise({
      kind: 'escalation',
      detail: 'key sup3r-secret at https://rpc.example.com/v2/k',
      operationId: 'op',
      at,
    });
    sink.raise({ kind: 'deployment_mismatch', detail: 'x', at });
    sink.raise({ kind: 'chain_mismatch', detail: 'y', at });
    expect(fatal).toEqual(['deployment_mismatch', 'chain_mismatch']);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed[0]).toMatchObject({
      level: 'warn',
      service: 'worker',
      msg: 'alarm',
      kind: 'escalation',
      detail: 'key <redacted> at <redacted-url>',
      operationId: 'op',
      complianceChangeId: null,
    });
    expect(parsed[1]?.level).toBe('error');
    expect([...FATAL_ALARMS].sort()).toEqual(['chain_mismatch', 'deployment_mismatch']);

    sink.onFatal = () => {
      throw new Error('boom');
    };
    expect(() => sink.raise({ kind: 'deployment_mismatch', detail: 'z', at })).not.toThrow();
    const broken = new WorkerAlarmSink(
      new WorkerLogger({
        level: 'log',
        secrets: [],
        write: () => {
          throw new Error('EPIPE');
        },
      }),
    );
    expect(() => broken.raise({ kind: 'escalation', detail: 'z', at })).not.toThrow();
  });
});

describe('WorkerLogger', () => {
  it('writes to stdout by default', () => {
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      new WorkerLogger({ level: 'log', secrets: [] }).log('to stdout');
      expect(String(write.mock.calls[0]?.[0])).toMatch(/"msg":"to stdout"}\n$/);
    } finally {
      write.mockRestore();
    }
  });

  it('filters by level, redacts, drops stacks, keeps string contexts only', () => {
    const lines: string[] = [];
    const log = new WorkerLogger({
      level: 'warn',
      secrets: ['sup3r-secret'],
      write: (l) => lines.push(l),
    });
    log.log('hidden');
    log.debug('hidden');
    log.verbose('hidden');
    log.warn('sup3r-secret', 'Ctx');
    log.error('failed', 'stack\n at secretFrame', 'Ctx2');
    log.warn('obj', { a: 1 });
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed.map((p) => [p.level, p.msg, p.context])).toEqual([
      ['warn', '<redacted>', 'Ctx'],
      ['error', 'failed', 'Ctx2'],
      ['warn', 'obj', undefined],
    ]);
    expect(lines.join('')).not.toContain('secretFrame');
    const all: string[] = [];
    const verbose = new WorkerLogger({ level: 'debug', secrets: [], write: (l) => all.push(l) });
    verbose.log('a');
    verbose.debug('b');
    verbose.verbose('c');
    expect(all).toHaveLength(3);
  });
});
