/**
 * @file Turning an error (or a handler's or caller's free text) into a short, safe string for
 * `outbox_message.last_error` and the audit trail.
 *
 * Why: errors from a chain client routinely quote the RPC URL, and RPC URLs carry API keys. A
 * message written to the database is read by operators, copied into tickets and kept forever, so
 * it must never contain a URL or a key. Three layers, in this order:
 *
 * 1. Literal secrets the caller knows (the configured RPC URL, an API key, a host), removed by
 *    value in every spelling a message can carry them: as written, `/`-escaped once or twice,
 *    JSON-escaped once or twice, percent-encoded once or twice, any case. A URL secret also
 *    contributes its parts (host, path, each path segment, credentials, query values), so
 *    "nonce too high at host/v2/KEY" is caught. Same idea as `makeRedactor` in the chain package,
 *    reimplemented here so the engine does not depend on chain internals.
 * 2. Anything that LOOKS like a URL: `scheme://...` with the separator plain, backslash-escaped any
 *    number of times (`https:\/\/`, `https:\\/\\/`) or percent-encoded any number of times
 *    (`https%3A%2F%2F`, `https%253A%252F%252F`).
 * 3. Anything that looks like a scheme-less host with a path (`eth.example.com/v2/KEY`,
 *    `10.0.0.1:8545/KEY`), with the same escaped or encoded slashes.
 *
 * Control characters are flattened so one message stays one line, and the result is bounded to
 * the column's limit.
 */

/** The longest text `last_error` holds (the database CHECKs it). */
export const MAX_ERROR_TEXT = 1000;

/** Secret pieces shorter than this are too short to be a secret and too common to remove. */
const MIN_SECRET_LENGTH = 4;

/** A slash as written, backslash-escaped any number of times, or percent-encoded any times. */
const SLASH = String.raw`(?:\\*\/|%(?:25)*2F)`;
const URL_LIKE = new RegExp(
  String.raw`\b[a-z][a-z0-9+.-]*(?::${SLASH}{2}|%(?:25)*3A${SLASH}{2})[^\s"'<>|]+`,
  'gi',
);
const HOST_PATH = new RegExp(
  // The tail stops at brackets and separators, which no key contains, so "(host/v2/KEY)" keeps its ")".
  String.raw`(?:\b(?:[a-z0-9-]+\.)+[a-z]{2,}|\b\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?${SLASH}[^\s"'<>|()[\]{},;]*`,
  'gi',
);
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f]+/g;

/** How `sanitizeText` and `describeError` treat a text. */
export interface SanitizeOptions {
  /** The maximum length (default `MAX_ERROR_TEXT`). */
  readonly max?: number;
  /** Literal secrets to remove by value (RPC URL, API key, host), in every escaped form. */
  readonly secrets?: readonly string[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The secret itself and, for a URL, every part of it that could hold a key. */
function secretPieces(secret: string): string[] {
  const out = [secret];
  try {
    const url = new URL(secret);
    out.push(url.href, url.host, url.hostname, `${url.host}${url.pathname}`);
    out.push(decode(url.username), decode(url.password));
    if (url.pathname.length > 1) out.push(url.pathname);
    if (url.search.length > 1) out.push(url.search.slice(1));
    for (const segment of url.pathname.split('/')) out.push(segment, decode(segment));
    for (const [, value] of url.searchParams) out.push(value);
  } catch {
    // Not a URL: the literal is all there is to remove.
  }
  return out.filter((p) => p.length >= MIN_SECRET_LENGTH);
}

/** Every spelling of `piece` a message can carry: escaped and encoded, once and twice. */
function spellings(piece: string): string[] {
  const json = (s: string): string => JSON.stringify(s).slice(1, -1);
  const slashEscaped = piece.replace(/\//g, '\\/');
  const once = [
    piece,
    slashEscaped,
    json(piece),
    json(slashEscaped),
    encodeURIComponent(piece),
    encodeURI(piece),
  ];
  const twice = once.flatMap((s) => [json(s), encodeURIComponent(s), s.replace(/\//g, '\\/')]);
  return [...once, ...twice];
}

function secretPatterns(secrets: readonly string[] | undefined): RegExp[] {
  if (secrets === undefined || secrets.length === 0) return [];
  const variants = new Set<string>();
  for (const secret of secrets) {
    if (typeof secret !== 'string') continue;
    for (const piece of secretPieces(secret)) for (const v of spellings(piece)) variants.add(v);
  }
  return [...variants]
    .filter((v) => v.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length)
    .map((v) => new RegExp(escapeRegExp(v), 'gi'));
}

/**
 * `text` with the literal `secrets` (every spelling), every URL-looking and host/path-looking
 * substring replaced, control characters turned into spaces, trimmed, and cut to `max` characters
 * (ending in `...` when cut). Never empty: an empty result becomes `(no message)`.
 *
 * @param text Untrusted text.
 * @param options Maximum length and literal secrets.
 */
export function sanitizeText(text: string, options: SanitizeOptions = {}): string {
  const max = options.max ?? MAX_ERROR_TEXT;
  let out = String(text);
  for (const pattern of secretPatterns(options.secrets)) out = out.replace(pattern, '<redacted>');
  out = out
    .replace(URL_LIKE, '<redacted-url>')
    .replace(HOST_PATH, '<redacted-url>')
    .replace(CONTROL, ' ')
    .trim();
  const nonEmpty = out.length === 0 ? '(no message)' : out;
  return nonEmpty.length <= max ? nonEmpty : `${nonEmpty.slice(0, Math.max(0, max - 3))}...`;
}

/**
 * `<ErrorClass>: <sanitized message>` for anything thrown. Non-errors are described by their type;
 * a value whose `toString` throws is described without it.
 *
 * @param err Whatever was thrown.
 * @param options Maximum length and literal secrets, as for `sanitizeText`.
 */
export function describeError(err: unknown, options: SanitizeOptions = {}): string {
  if (err instanceof Error) return sanitizeText(`${err.name}: ${err.message}`, options);
  let text: string;
  try {
    text = String(err);
  } catch {
    text = '(unprintable)';
  }
  return sanitizeText(`${typeof err}: ${text}`, options);
}
