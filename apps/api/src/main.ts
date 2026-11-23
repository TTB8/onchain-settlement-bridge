/**
 * @file Process entry point of the API: start from `process.env`, or print why not and exit 1.
 *
 * A `ConfigError` lists every invalid variable by name and never a value, so it is printed as is
 * (one problem per line). Anything else is printed as `<ErrorClass>: <message>`, redacted (no
 * URL), never with a stack trace.
 */

import { describeError } from '@bridge/engine';
import { ConfigError } from '@bridge/engine/env';

import { startApi } from './app';

startApi(process.env).catch((err: unknown) => {
  const why = err instanceof ConfigError ? err.message : describeError(err, { max: 4000 });
  process.stderr.write(`api: refusing to start: ${why}\n`);
  process.exit(1);
});
