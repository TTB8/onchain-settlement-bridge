/**
 * @file The shape of an audit-trail entry and its validating constructor.
 *
 * Every state change the bridge makes (an operation moving status, a compliance change, an indexer
 * rollback, a reconciliation run) is recorded as one append-only entry. The domain only defines
 * the record: the time is passed in (never read from a clock here) and the engine writes it in the
 * same database transaction as the change it describes, so the trail cannot miss a change.
 */

import { InvalidInputError } from './errors';
import { isBytes32, type TxHash } from './primitives';

/** The kinds of thing whose changes are audited. */
export type AuditEntity = 'operation' | 'compliance_change' | 'indexer' | 'reconciliation';

/** One append-only record of a state change. */
export interface AuditEntry {
  /** What kind of thing changed. */
  readonly entity: AuditEntity;
  /** Which one. */
  readonly entityId: string;
  /** The state before, or `null` for a creation. */
  readonly fromState: string | null;
  /** The state after. Equal to `fromState` for a re-attempt (e.g. a fee bump). */
  readonly toState: string;
  /** The transaction involved, when there is one. */
  readonly txHash?: TxHash;
  /** A human-readable explanation, such as the failure reason. Must not contain secrets or PII. */
  readonly detail: string;
  /** When the change happened (UTC). */
  readonly at: Date;
}

/** Inputs to `auditEntryFor`; the same fields as `AuditEntry`. */
export type AuditEntryInput = AuditEntry;

const ENTITIES: readonly AuditEntity[] = [
  'operation',
  'compliance_change',
  'indexer',
  'reconciliation',
];

/**
 * Builds a validated, frozen audit entry. Throws `InvalidInputError` for an unknown entity, an
 * empty id or state, a malformed transaction hash or an invalid date. The date is copied so a
 * caller mutating its `Date` afterwards cannot rewrite history.
 */
export function auditEntryFor(input: AuditEntryInput): AuditEntry {
  if (!ENTITIES.includes(input.entity)) {
    throw new InvalidInputError(`unknown audit entity '${String(input.entity)}'`);
  }
  if (typeof input.entityId !== 'string' || input.entityId.length === 0) {
    throw new InvalidInputError('audit entityId must be a non-empty string');
  }
  if (typeof input.toState !== 'string' || input.toState.length === 0) {
    throw new InvalidInputError('audit toState must be a non-empty string');
  }
  if (
    input.fromState !== null &&
    (typeof input.fromState !== 'string' || input.fromState.length === 0)
  ) {
    throw new InvalidInputError('audit fromState must be null or a non-empty string');
  }
  if (input.txHash !== undefined && !isBytes32(input.txHash)) {
    throw new InvalidInputError(
      `audit txHash must be a lowercase 32-byte hash, got ${String(input.txHash)}`,
    );
  }
  if (typeof input.detail !== 'string') {
    throw new InvalidInputError('audit detail must be a string');
  }
  if (!(input.at instanceof Date) || Number.isNaN(input.at.getTime())) {
    throw new InvalidInputError('audit at must be a valid Date');
  }
  const entry: AuditEntry = {
    entity: input.entity,
    entityId: input.entityId,
    fromState: input.fromState,
    toState: input.toState,
    ...(input.txHash !== undefined ? { txHash: input.txHash } : {}),
    detail: input.detail,
    at: new Date(input.at.getTime()),
  };
  return Object.freeze(entry);
}
