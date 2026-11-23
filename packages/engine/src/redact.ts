/**
 * @file Turning an error (or a handler's free-text detail) into a short, safe string for
 * `outbox_message.last_error` and the audit trail.
 *
 * Why: errors from a chain client routinely quote the RPC URL, and RPC URLs carry API keys. A
 * message written to the database is read by operators, copied into tickets and kept forever, so
 * it must never contain a URL. The pattern below is the same generic one the chain package uses
 * (`redactUrls`), reimplemented here so the engine does not depend on chain internals: any
 * `scheme://...`, its JSON-escaped form (`https:\/\/...`) and its percent-encoded form
 * (`https%3A%2F%2F...`). Control characters are flattened so one message stays one line, and the
 * result is bounded to the column's limit.
 */

/** The longest text `last_error` holds (the database CHECKs it). */
export const MAX_ERROR_TEXT = 1000;

const URL_LIKE = /\b[a-z][a-z0-9+.-]*(?::\/\/|:\\\/\\\/|%3A%2F%2F)[^\s"'<>|]+/gi;
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f]+/g;

/**
 * `text` with every URL-looking substring replaced by `<redacted-url>`, control characters turned
 * into spaces, trimmed, and cut to `max` characters (ending in `...` when cut). Never empty: an
 * empty result becomes `(no message)`.
 *
 * @param text Untrusted text.
 * @param max The maximum length (default `MAX_ERROR_TEXT`).
 */
export function sanitizeText(text: string, max: number = MAX_ERROR_TEXT): string {
  const cleaned = text.replace(URL_LIKE, '<redacted-url>').replace(CONTROL, ' ').trim();
  const nonEmpty = cleaned.length === 0 ? '(no message)' : cleaned;
  return nonEmpty.length <= max ? nonEmpty : `${nonEmpty.slice(0, Math.max(0, max - 3))}...`;
}

/**
 * `<ErrorClass>: <sanitized message>` for anything thrown. Non-errors are described by their type;
 * a value whose `toString` throws is described without it.
 *
 * @param err Whatever was thrown.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return sanitizeText(`${err.name}: ${err.message}`);
  let text: string;
  try {
    text = String(err);
  } catch {
    text = '(unprintable)';
  }
  return sanitizeText(`${typeof err}: ${text}`);
}
