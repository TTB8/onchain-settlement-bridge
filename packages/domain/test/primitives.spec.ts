import { assertAddress, InvalidInputError, isAddress, isBytes32, ZERO_ADDRESS } from '../src';

describe('isAddress', () => {
  it('accepts lowercase 20-byte hex, including the zero address', () => {
    expect(isAddress(ZERO_ADDRESS)).toBe(true);
    expect(isAddress(`0x${'ab'.repeat(20)}`)).toBe(true);
  });

  it('rejects checksummed, short, long, unprefixed and non-string values', () => {
    expect(isAddress(`0x${'AB'.repeat(20)}`)).toBe(false);
    expect(isAddress(`0x${'ab'.repeat(19)}`)).toBe(false);
    expect(isAddress(`0x${'ab'.repeat(21)}`)).toBe(false);
    expect(isAddress('ab'.repeat(20))).toBe(false);
    expect(isAddress(42)).toBe(false);
  });
});

describe('isBytes32', () => {
  it('accepts lowercase 32-byte hex only', () => {
    expect(isBytes32(`0x${'0'.repeat(64)}`)).toBe(true);
    expect(isBytes32(`0x${'F'.repeat(64)}`)).toBe(false);
    expect(isBytes32(`0x${'0'.repeat(63)}`)).toBe(false);
    expect(isBytes32(undefined)).toBe(false);
  });
});

describe('assertAddress', () => {
  it('passes a valid address and throws a labelled InvalidInputError otherwise', () => {
    expect(() => assertAddress(ZERO_ADDRESS, 'x')).not.toThrow();
    expect(() => assertAddress('0xABC', 'transfer.to')).toThrow(InvalidInputError);
    expect(() => assertAddress('0xABC', 'transfer.to')).toThrow(/transfer\.to/);
  });
});
