import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/env.ts';

const base = {
  MONGO_URL: 'mongodb://user:s3cret-value@127.0.0.1:27017/streamhub',
  REDIS_URL: 'redis://default:pw@127.0.0.1:6379/0',
  SESSION_SECRET: 'x'.repeat(48),
  MFA_ENCRYPTION_KEY: 'm'.repeat(48),
};
const productionBase = {
  ...base,
  NODE_ENV: 'production',
  WEB_ORIGIN: 'https://streamhub.example.com',
  S3_BUCKET_UPLOADS: 'streamhub-dev-uploads-123456789012',
};

describe('loadConfig', () => {
  it('requires an explicit uploads bucket in production, with a local default otherwise', () => {
    expect(loadConfig(base).S3_BUCKET_UPLOADS).toBe('streamhub-uploads');
    const { S3_BUCKET_UPLOADS: _omit, ...withoutBucket } = productionBase;
    expect(() => loadConfig(withoutBucket)).toThrowError(
      /S3_BUCKET_UPLOADS: is required in production/,
    );
    expect(loadConfig(productionBase).S3_BUCKET_UPLOADS).toBe(productionBase.S3_BUCKET_UPLOADS);
  });

  it('takes storage keys as a pair, or none for role credentials', () => {
    expect(() => loadConfig({ ...base, S3_ACCESS_KEY_ID: 'only-the-id' })).toThrowError(
      /S3_ACCESS_KEY_ID: set both/,
    );
    const roleBased = loadConfig(productionBase);
    expect(roleBased.S3_ACCESS_KEY_ID).toBeUndefined();
    expect(roleBased.S3_ENDPOINT).toBeUndefined();
  });

  it('rejects a part size that would need more than 10,000 parts', () => {
    expect(() =>
      loadConfig({
        ...base,
        UPLOAD_MAX_BYTES: String(50 * 1024 ** 3),
        UPLOAD_PART_SIZE_BYTES: String(5 * 1024 * 1024),
      }),
    ).toThrowError(/UPLOAD_PART_SIZE_BYTES/);
  });

  it('rejects a MONGO_URL without a database name', () => {
    for (const url of [
      'mongodb+srv://u:p@cluster0.abc.mongodb.net/?retryWrites=true',
      'mongodb+srv://u:p@cluster0.abc.mongodb.net?retryWrites=true',
      'mongodb://u:p@127.0.0.1:27017',
    ]) {
      expect(() => loadConfig({ ...base, MONGO_URL: url })).toThrowError(/MONGO_URL/);
    }
    expect(
      loadConfig({ ...base, MONGO_URL: 'mongodb+srv://u:p@c.abc.mongodb.net/streamhub?w=majority' })
        .MONGO_URL,
    ).toContain('/streamhub?');
  });

  it('applies defaults for optional values', () => {
    const config = loadConfig({ ...base });
    expect(config.API_PORT).toBe(4000);
    expect(config.NODE_ENV).toBe('development');
    expect(config.API_DOCS_ENABLED).toBe(true);
    expect(config.LOG_PRETTY).toBe(false);
  });

  it('coerces numeric and boolean strings', () => {
    const config = loadConfig({
      ...base,
      API_PORT: '4555',
      LOG_PRETTY: 'true',
      API_DOCS_ENABLED: '0',
    });
    expect(config.API_PORT).toBe(4555);
    expect(config.LOG_PRETTY).toBe(true);
    expect(config.API_DOCS_ENABLED).toBe(false);
  });

  it('disables docs by default in production', () => {
    expect(loadConfig(productionBase).API_DOCS_ENABLED).toBe(false);
  });

  it('reports each missing required variable by name', () => {
    expect(() => loadConfig({})).toThrowError(/MONGO_URL: is required/);
    expect(() => loadConfig({})).toThrowError(/REDIS_URL: is required/);
    expect(() => loadConfig({})).toThrowError(/SESSION_SECRET: is required/);
    expect(() => loadConfig({})).toThrowError(/MFA_ENCRYPTION_KEY: is required/);
  });

  it('rejects a short session secret', () => {
    expect(() => loadConfig({ ...base, SESSION_SECRET: 'too-short' })).toThrowError(
      /SESSION_SECRET: must be at least 32/,
    );
  });

  it('enables secure cookies by default only in production', () => {
    expect(loadConfig(base).COOKIE_SECURE).toBe(false);
    expect(loadConfig(productionBase).COOKIE_SECURE).toBe(true);
  });

  it('refuses insecure cookie or origin settings in production', () => {
    expect(() => loadConfig({ ...productionBase, COOKIE_SECURE: 'false' })).toThrowError(
      /COOKIE_SECURE/,
    );
    expect(() =>
      loadConfig({ ...productionBase, WEB_ORIGIN: 'http://streamhub.example.com' }),
    ).toThrowError(/WEB_ORIGIN/);
  });

  it('parses extra trusted origins and rejects malformed ones', () => {
    expect(
      loadConfig({
        ...base,
        CSRF_EXTRA_TRUSTED_ORIGINS: 'http://127.0.0.1:4000, http://localhost:4000',
      }).CSRF_EXTRA_TRUSTED_ORIGINS,
    ).toEqual(['http://127.0.0.1:4000', 'http://localhost:4000']);
    expect(() =>
      loadConfig({ ...base, CSRF_EXTRA_TRUSTED_ORIGINS: 'javascript:alert(1)' }),
    ).toThrowError(/CSRF_EXTRA_TRUSTED_ORIGINS/);
  });

  it('collects every problem in one error', () => {
    try {
      loadConfig({ MONGO_URL: 'postgres://x', API_PORT: '99999', LOG_LEVEL: 'loud' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const keys = (err as ConfigError).issues.map((i) => i.split(':')[0]);
      expect(keys).toEqual(expect.arrayContaining(['MONGO_URL', 'API_PORT', 'LOG_LEVEL']));
    }
  });

  it('never includes supplied values in the error message (they may be secrets)', () => {
    try {
      loadConfig({ MONGO_URL: 'not-a-url-but-a-secret-xyz', API_PORT: 'also-secret-abc' });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('secret-xyz');
      expect((err as Error).message).not.toContain('secret-abc');
    }
  });

  it('rejects pretty logs in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', LOG_PRETTY: 'true' })).toThrowError(
      /LOG_PRETTY/,
    );
  });
});
