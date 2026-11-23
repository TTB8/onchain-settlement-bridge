/**
 * @file Request ids and the access log.
 *
 * Every request gets a fresh random id (never one supplied by the client: a client-chosen id
 * could collide with another request's in the logs or inject text into them). It is returned in
 * `X-Request-Id` and in every problem's `instance`. One log line per request records method,
 * path (no query string), status and duration. Headers and bodies are never logged: the
 * `Authorization` header is a credential, and bodies carry wallet addresses and amounts.
 */

import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

import type { JsonLogger } from './logger';

const REQUEST_ID = Symbol('requestId');

type WithId = Request & { [REQUEST_ID]?: string };

/**
 * The id assigned to `req`, or undefined before the middleware ran.
 *
 * @param req The request.
 */
export function requestIdOf(req: Request): string | undefined {
  return (req as WithId)[REQUEST_ID];
}

/**
 * Express middleware: assigns the id, sets `X-Request-Id`, logs one line when the response ends.
 *
 * @param logger The structured logger.
 */
export function requestContext(logger: JsonLogger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const id = randomUUID();
    (req as WithId)[REQUEST_ID] = id;
    res.setHeader('X-Request-Id', id);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      logger.emit('log', 'request', {
        requestId: id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Number((process.hrtime.bigint() - started) / 1_000_000n),
      });
    });
    next();
  };
}
