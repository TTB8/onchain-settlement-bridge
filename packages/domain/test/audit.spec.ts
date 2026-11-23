import { type AuditEntity, auditEntryFor, type AuditEntryInput, InvalidInputError } from '../src';
import { txh } from './support/fixtures';

const base: AuditEntryInput = {
  entity: 'operation',
  entityId: 'op-1',
  fromState: 'submitted',
  toState: 'confirmed',
  txHash: txh(1),
  detail: 'confirmed at depth 12',
  at: new Date('2026-03-01T12:00:00Z'),
};

describe('auditEntryFor', () => {
  it('builds a frozen entry with every field', () => {
    const e = auditEntryFor(base);
    expect(e).toEqual(base);
    expect(Object.isFrozen(e)).toBe(true);
  });

  it('copies the date so later mutation of the input cannot rewrite history', () => {
    const at = new Date('2026-03-01T12:00:00Z');
    const e = auditEntryFor({ ...base, at });
    at.setUTCFullYear(2000);
    expect(e.at.toISOString()).toBe('2026-03-01T12:00:00.000Z');
  });

  it('allows a creation (fromState null), a re-attempt (same state) and no tx hash', () => {
    const noTx: AuditEntryInput = { ...base };
    delete (noTx as { txHash?: string }).txHash;
    const e = auditEntryFor({ ...noTx, fromState: null });
    expect(e.fromState).toBeNull();
    expect('txHash' in e).toBe(false);
    expect(auditEntryFor({ ...base, fromState: 'submitted', toState: 'submitted' }).toState).toBe(
      'submitted',
    );
  });

  it.each<[string, Partial<AuditEntryInput>]>([
    ['unknown entity', { entity: 'user' as AuditEntity }],
    ['empty entityId', { entityId: '' }],
    ['empty toState', { toState: '' }],
    ['empty fromState', { fromState: '' }],
    ['malformed txHash', { txHash: '0x1234' }],
    ['non-string detail', { detail: 5 as unknown as string }],
    ['invalid date', { at: new Date('nope') }],
    ['non-Date at', { at: '2026-01-01' as unknown as Date }],
  ])('rejects %s', (_label, patch) => {
    expect(() => auditEntryFor({ ...base, ...patch })).toThrow(InvalidInputError);
  });
});
