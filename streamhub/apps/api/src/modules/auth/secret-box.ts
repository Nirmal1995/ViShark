import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Encrypts small secrets at rest (TOTP seeds) with AES-256-GCM.
 *
 * - The key is derived with HKDF-SHA256 from MFA_ENCRYPTION_KEY, which lives
 *   only in the environment (AWS Secrets Manager in production), never in the
 *   database. A database dump alone therefore cannot produce valid codes.
 * - GCM is authenticated: any change to the stored value makes decryption fail.
 * - The user ID is bound as additional authenticated data, so an attacker with
 *   database write access cannot copy their own encrypted seed onto another
 *   account.
 * - Stored format "v1.<iv>.<tag>.<ciphertext>" (base64url). The version prefix
 *   leaves room for key rotation later.
 */
export type SecretBox = {
  seal: (plaintext: Buffer, associatedData: string) => string;
  open: (sealed: string, associatedData: string) => Buffer;
  /**
   * Keyed hash (HMAC-SHA256) for values that are only ever compared, such as
   * recovery codes. Unlike a plain SHA-256, a database dump alone is not
   * enough to brute-force them offline: the key is not in the database.
   */
  digest: (value: string) => string;
};

const VERSION = 'v1';
const INFO = 'streamhub/mfa-totp-secret/v1';
const DIGEST_INFO = 'streamhub/mfa-recovery-code/v1';

export function createSecretBox(masterKey: string): SecretBox {
  if (masterKey.length < 32) throw new Error('encryption key must be at least 32 characters');
  // Separate keys for separate purposes, both derived from the one secret.
  const key = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), INFO, 32));
  const digestKey = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), DIGEST_INFO, 32));

  return {
    seal(plaintext, associatedData) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(associatedData));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [VERSION, iv, tag, ciphertext]
        .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
        .join('.');
    },
    open(sealed, associatedData) {
      const [version, iv, tag, ciphertext] = sealed.split('.');
      if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
        throw new Error('unsupported encrypted value');
      }
      // authTagLength pins the tag to 16 bytes: GCM would otherwise accept a
      // truncated tag, which is far easier to forge.
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), {
        authTagLength: 16,
      });
      decipher.setAAD(Buffer.from(associatedData));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'base64url')),
        decipher.final(),
      ]);
    },
    digest(value) {
      return createHmac('sha256', digestKey).update(value).digest('hex');
    },
  };
}
