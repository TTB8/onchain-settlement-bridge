/**
 * @file The global exception filter: every error leaves the API as `application/problem+json`
 * built by `toProblem`, never as a stack trace, a SQL fragment or an engine message.
 *
 * An unrecognised error is logged (redacted: `describeError` with the configured secrets, the
 * class name and message only, never the stack) with the request id, and answered as a 500
 * `internal` problem that carries nothing but that id.
 */

import { type ArgumentsHost, Catch, type ExceptionFilter, Inject } from '@nestjs/common';
import { describeError } from '@bridge/engine';
import type { Request, Response } from 'express';

import { requestIdOf } from './request-context';
import type { JsonLogger } from './logger';
import { LOGGER } from './tokens';
import { toProblem } from './problem';

/** Catches everything and answers with a problem. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  /** @param logger The structured logger. */
  constructor(@Inject(LOGGER) private readonly logger: JsonLogger) {}

  /** @inheritdoc */
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    sendProblem(exception, req, res, this.logger);
  }
}

/**
 * Writes the problem for `exception` to `res` (also used by the Express-level error handler that
 * catches body-parser failures before Nest's pipeline).
 *
 * @param exception Whatever was thrown.
 * @param req The request (for its id).
 * @param res The response.
 * @param logger Where an unexpected error is logged.
 */
export function sendProblem(
  exception: unknown,
  req: Request,
  res: Response,
  logger: JsonLogger,
): void {
  const requestId = requestIdOf(req);
  const mapped = toProblem(exception, requestId);
  if (mapped.unexpected) {
    logger.emit('error', 'unhandled error', {
      requestId: requestId ?? null,
      error: describeError(exception),
    });
  }
  if (res.headersSent) return;
  for (const [name, value] of Object.entries(mapped.headers)) res.setHeader(name, value);
  res.status(mapped.body.status).type('application/problem+json').send(JSON.stringify(mapped.body));
}
