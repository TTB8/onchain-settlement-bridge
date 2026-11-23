import { InvalidReferenceError, isReference, referenceFromUuid, uuidFromReference } from '../src';
import { prng, randInt } from './support/fixtures';

describe('referenceFromUuid', () => {
  it('left-pads the 16 UUID bytes with 16 zero bytes', () => {
    expect(referenceFromUuid('123e4567-e89b-12d3-a456-426614174000')).toBe(
      '0x00000000000000000000000000000000123e4567e89b12d3a456426614174000',
    );
  });

  it('accepts upper case and always returns lower case', () => {
    expect(referenceFromUuid('ABCDEF01-2345-6789-ABCD-EF0123456789')).toBe(
      '0x00000000000000000000000000000000abcdef0123456789abcdef0123456789',
    );
  });

  it('rejects the nil UUID, because the contracts reject the zero reference', () => {
    expect(() => referenceFromUuid('00000000-0000-0000-0000-000000000000')).toThrow(
      InvalidReferenceError,
    );
  });

  it.each([
    '',
    '123e4567e89b12d3a456426614174000',
    '{123e4567-e89b-12d3-a456-426614174000}',
    '123e4567-e89b-12d3-a456-42661417400',
    '123e4567-e89b-12d3-a456-4266141740000',
    'g23e4567-e89b-12d3-a456-426614174000',
    ' 123e4567-e89b-12d3-a456-426614174000',
  ])('rejects malformed %p', (bad) => {
    expect(() => referenceFromUuid(bad)).toThrow(InvalidReferenceError);
  });

  it('rejects a non-string', () => {
    expect(() => referenceFromUuid(42 as unknown as string)).toThrow(InvalidReferenceError);
  });
});

describe('uuidFromReference', () => {
  it('recovers the hyphenated UUID', () => {
    expect(
      uuidFromReference('0x00000000000000000000000000000000123e4567e89b12d3a456426614174000'),
    ).toBe('123e4567-e89b-12d3-a456-426614174000');
  });

  it('rejects a reference with non-zero high bytes (not made by this bridge)', () => {
    expect(() =>
      uuidFromReference('0x00000000000000000000000000000001123e4567e89b12d3a456426614174000'),
    ).toThrow(/non-zero high bytes/);
    expect(() => uuidFromReference(`0x${'f'.repeat(64)}`)).toThrow(InvalidReferenceError);
  });

  it('rejects the zero reference', () => {
    expect(() => uuidFromReference(`0x${'0'.repeat(64)}`)).toThrow(/zero reference/);
  });

  it.each([
    '0x1234',
    `0x${'0'.repeat(63)}`,
    `0x${'0'.repeat(65)}`,
    `0x${'0'.repeat(32)}ABCDEF0123456789ABCDEF0123456789`,
    `${'0'.repeat(64)}`,
  ])('rejects malformed %p', (bad) => {
    expect(() => uuidFromReference(bad)).toThrow(InvalidReferenceError);
  });
});

describe('round trip', () => {
  it.each([
    '00000000-0000-0000-0000-000000000001',
    'ffffffff-ffff-ffff-ffff-ffffffffffff',
    '80000000-0000-0000-0000-000000000000',
    '00000000-0000-4000-8000-000000000000',
  ])('edge UUID %s survives', (uuid) => {
    const ref = referenceFromUuid(uuid);
    expect(isReference(ref)).toBe(true);
    expect(uuidFromReference(ref)).toBe(uuid);
  });

  it('holds for 2000 seeded random UUIDs', () => {
    const rand = prng(42);
    const hex = '0123456789abcdef';
    for (let i = 0; i < 2000; i += 1) {
      let raw = '';
      for (let j = 0; j < 32; j += 1) raw += hex[randInt(rand, 16)];
      if (/^0+$/.test(raw)) continue;
      const uuid = `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
      expect(uuidFromReference(referenceFromUuid(uuid))).toBe(uuid);
    }
  });
});

describe('isReference', () => {
  it('recognises only bridge-made references', () => {
    expect(isReference(`0x${'0'.repeat(63)}1`)).toBe(true);
    expect(isReference(`0x${'0'.repeat(64)}`)).toBe(false);
    expect(isReference(`0x1${'0'.repeat(63)}`)).toBe(false);
    expect(isReference(`0x${'0'.repeat(63)}A`)).toBe(false);
    expect(isReference(null)).toBe(false);
  });
});
