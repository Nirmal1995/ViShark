import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (TOTP, RFC 6238), the 6-digit codes shown by
 * authenticator apps (Google Authenticator, Microsoft Authenticator, 1Password).
 *
 * Built on node:crypto HMAC rather than a library: the algorithm is about 20
 * lines, and the tests check it against the official RFC 6238 test vectors
 * (ADR-031). No cryptographic primitive is implemented here; only the
 * standard HMAC-SHA1 truncation that every authenticator app uses.
 */

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Accept the previous and next 30-second step too, for clock drift. */
export const TOTP_WINDOW = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding, the format authenticator apps expect. */
export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error('invalid base32 character');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160-bit secret, the size RFC 4226 recommends for HMAC-SHA1. */
export const generateTotpSecret = () => randomBytes(20);

export const timeStep = (nowMs: number) => Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);

/** HOTP (RFC 4226): HMAC-SHA1 of the counter, dynamically truncated to N digits. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secret).update(message).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export const totpAt = (secret: Buffer, nowMs: number, digits = TOTP_DIGITS) =>
  hotp(secret, timeStep(nowMs), digits);

/**
 * Checks a code against the current step and its neighbours. Returns the
 * matching step (the caller stores it to refuse the same code twice) or null.
 * Every candidate is compared, in constant time, so the response time does not
 * reveal which step matched.
 */
export function verifyTotp(secret: Buffer, code: string, nowMs: number): number | null {
  const current = timeStep(nowMs);
  const given = Buffer.from(code.padEnd(TOTP_DIGITS, ' ').slice(0, TOTP_DIGITS));
  let matched: number | null = null;
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step++) {
    if (timingSafeEqual(Buffer.from(hotp(secret, step)), given)) matched ??= step;
  }
  return matched;
}

/**
 * otpauth:// URI that authenticator apps import (usually as a QR code, which
 * the web app renders from this string). Format: Google Authenticator "Key Uri".
 */
export function otpauthUri(options: { issuer: string; account: string; secret: Buffer }): string {
  const label = `${encodeURIComponent(options.issuer)}:${encodeURIComponent(options.account)}`;
  const params = new URLSearchParams({
    secret: base32Encode(options.secret),
    issuer: options.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
