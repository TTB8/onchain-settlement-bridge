/**
 * @file Routes each claimed outbox row to the handler of its signer: `settlement` rows to the
 * settlement submitter, `compliance` rows to the compliance submitter. One dispatcher, one lease
 * discipline, one backoff policy for both; the database guarantees (guard 6d) that a row's signer
 * matches its subject, so the signer alone picks the handler.
 */

import type { OutboxMessage, SignerName } from '@bridge/db';

import type { HandlerContext, OutboxHandler, OutboxOutcome } from './outbox-dispatcher';

/** An `OutboxHandler` that delegates by `row.signer`. */
export class SignerRouter implements OutboxHandler {
  /** @param handlers One handler per signer. */
  constructor(private readonly handlers: Readonly<Record<SignerName, OutboxHandler>>) {}

  /** @inheritdoc */
  handle(row: OutboxMessage, context: HandlerContext): Promise<OutboxOutcome> {
    const handler = this.handlers[row.signer];
    // Fail closed: a signer with no handler is a definite refusal, never a silent "done".
    if (handler === undefined) return Promise.resolve({ failed: 'no_handler_for_signer' });
    return handler.handle(row, context);
  }
}
