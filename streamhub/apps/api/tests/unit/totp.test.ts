import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  hotp,
  otpauthUri,
  totpAt,
  verifyTotp,
} from '../../src/modules/auth/totp.ts';

// Test secret from RFC 4226 / RFC 6238 Appendix B (SHA-1).
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('base32 (RFC 4648 section 10 vectors, no padding)', () => {
  it.each([
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ])('encodes %j as %s and back', (plain, encoded) => {
    expect(base32Encode(Buffer.from(plain))).toBe(encoded);
    expect(base32Decode(encoded).toString()).toBe(plain);
  });

  it('decodes lowercase and padded input', () => {
    expect(base32Decode('mzxw6ytboi======').toString()).toBe('foobar');
  });

  it('rejects characters outside the alphabet', () => {
    expect(() => base32Decode('MZXW1')).toThrow(/invalid base32/);
  });
});

describe('HOTP (RFC 4226 Appendix D)', () => {
  const expected = [
    '755224',
    '287082',
    '359152',
    '969429',
    '338314',
    '254676',
    '287922',
    '162583',
    '399871',
    '520489',
  ];
  it.each(expected.map((code, counter) => [counter, code]))(
    'counter %i gives %s',
    (counter, code) => {
      expect(hotp(RFC_SECRET, counter)).toBe(code);
    },
  );
});

describe('TOTP (RFC 6238 Appendix B, SHA-1, 8 digits)', () => {
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('time %i gives %s', (seconds, code) => {
    expect(totpAt(RFC_SECRET, seconds * 1000, 8)).toBe(code);
  });
});

describe('verifyTotp', () => {
  const now = 1_700_000_000_000;
  const step = Math.floor(now / 30_000);

  it('accepts the current code and returns its time step', () => {
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now), now)).toBe(step);
  });

  it('accepts one step of clock drift either way', () => {
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now - 30_000), now)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now + 30_000), now)).toBe(step + 1);
  });

  it('rejects codes two or more steps away', () => {
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now - 60_000), now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now + 60_000), now)).toBeNull();
  });

  it('rejects a wrong code and a code for another secret', () => {
    const code = totpAt(RFC_SECRET, now);
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
    expect(verifyTotp(RFC_SECRET, wrong, now)).toBeNull();
    expect(verifyTotp(Buffer.from('another secret value'), code, now)).toBeNull();
  });
});

describe('otpauthUri', () => {
  it('builds the URI authenticator apps import, with the secret in base32', () => {
    const uri = new URL(
      otpauthUri({
        issuer: 'StreamHub',
        account: 'admin@example.com',
        secret: Buffer.from('foobar'),
      }),
    );
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/StreamHub:admin@example.com');
    expect(uri.searchParams.get('secret')).toBe('MZXW6YTBOI');
    expect(uri.searchParams.get('issuer')).toBe('StreamHub');
    expect(uri.searchParams.get('digits')).toBe('6');
    expect(uri.searchParams.get('period')).toBe('30');
  });
});
