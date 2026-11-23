/**
 * @file Process entry point of the worker: run from `process.env` and exit with the runner's code
 * (0 after a clean signal-initiated stop, 1 for any refusal or unclean stop).
 */

import { runWorker } from './worker';

void runWorker(process.env).then((code) => process.exit(code));
