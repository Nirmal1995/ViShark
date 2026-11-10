import { describe, expect, it } from 'vitest';
import { createSecretBox } from '../../src/modules/auth/secret-box.ts';

const KEY = 'unit-test-encryption-key-0123456789abcdef';
const secret = Buffer.from('totp seed bytes 1234');

describe('secret box (AES-256-GCM)', () => {
  const box = createSecretBox(KEY);

  it('round-trips a secret and never stores it in clear', () => {
    const sealed = box.seal(secret, 'user:1');
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(sealed).not.toContain(secret.toString('base64url'));
    expect(box.open(sealed, 'user:1').equals(secret)).toBe(true);
  });

  it('uses a fresh IV each time', () => {
    expect(box.seal(secret, 'user:1')).not.toBe(box.seal(secret, 'user:1'));
  });

  it('refuses a seed copied to another account (bound to the user ID)', () => {
    expect(() => box.open(box.seal(secret, 'user:1'), 'user:2')).toThrow();
  });

  it('refuses a modified ciphertext', () => {
    const [v, iv, tag, ct] = box.seal(secret, 'user:1').split('.');
    const flipped = Buffer.from(ct!, 'base64url');
    flipped[0] = flipped[0]! ^ 1;
    expect(() =>
      box.open([v, iv, tag, flipped.toString('base64url')].join('.'), 'user:1'),
    ).toThrow();
  });

  it('refuses a truncated authentication tag', () => {
    const [v, iv, tag, ct] = box.seal(secret, 'user:1').split('.');
    const short = Buffer.from(tag!, 'base64url').subarray(0, 4).toString('base64url');
    expect(() => box.open([v, iv, short, ct].join('.'), 'user:1')).toThrow();
  });

  it('refuses to decrypt with a different key', () => {
    const other = createSecretBox('another-encryption-key-0123456789abcdef');
    expect(() => other.open(box.seal(secret, 'user:1'), 'user:1')).toThrow();
  });

  it('refuses unknown formats and short keys', () => {
    expect(() => box.open('v2.a.b.c', 'user:1')).toThrow(/unsupported/);
    expect(() => createSecretBox('short')).toThrow(/at least 32/);
  });

  it('digest is keyed: same input, different key, different result', () => {
    const other = createSecretBox('another-encryption-key-0123456789abcdef');
    expect(box.digest('abcdefghjk')).toBe(box.digest('abcdefghjk'));
    expect(box.digest('abcdefghjk')).not.toBe(other.digest('abcdefghjk'));
  });
});
