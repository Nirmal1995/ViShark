import { z } from 'zod';

/**
 * All runtime configuration comes from environment variables and is validated
 * once at startup. The process refuses to start with invalid configuration
 * (fail fast) instead of failing later on the first request that needs it.
 */

const booleanFromString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const port = z.coerce.number().int().min(1).max(65_535);

const originList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.url({ protocol: /^https?$/ })));

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    API_HOST: z.string().min(1).default('127.0.0.1'),
    API_PORT: port.default(4000),
    API_METRICS_HOST: z.string().min(1).default('127.0.0.1'),
    API_METRICS_PORT: port.default(4001),
    API_DOCS_ENABLED: booleanFromString.optional(),
    API_BODY_LIMIT: z
      .string()
      .regex(/^\d+(b|kb|mb)$/i, 'use a size like 100kb or 1mb')
      .default('100kb'),
    // Number of reverse proxies in front of the API (0 locally; CloudFront + ALB in AWS).
    // Required to read the real client IP from X-Forwarded-For safely.
    API_TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
    API_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),

    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    LOG_PRETTY: booleanFromString.default(false),

    MONGO_URL: z
      .string()
      .regex(/^mongodb(\+srv)?:\/\//, 'must start with mongodb:// or mongodb+srv://')
      // Without a database name the driver silently uses "test" (seen on the
      // first dev deploy, where a least-privilege user then got "not allowed").
      .regex(
        /^mongodb(\+srv)?:\/\/[^/?]+\/[^/?]+/,
        'must name the database after the host, e.g. .../streamhub?...',
      ),
    MONGO_SERVER_SELECTION_TIMEOUT_MS: z.coerce.number().int().min(500).default(5000),

    REDIS_URL: z.string().regex(/^rediss?:\/\//, 'must start with redis:// or rediss://'),

    // Browser origin of the web app. State-changing requests must come from here.
    WEB_ORIGIN: z.url({ protocol: /^https?$/ }).default('http://localhost:5273'),
    // Extra trusted origins, comma separated (for example Swagger UI on the API port in development).
    CSRF_EXTRA_TRUSTED_ORIGINS: originList.default([]),

    SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
    SESSION_IDLE_TIMEOUT_MINUTES: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .default(30),
    SESSION_ABSOLUTE_TIMEOUT_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .default(12),
    COOKIE_SECURE: booleanFromString.optional(),

    // Argon2id cost. Defaults are the OWASP minimum (19 MiB, 2 iterations, 1 lane).
    ARGON2_MEMORY_KIB: z.coerce.number().int().min(19_456).max(1_048_576).default(19_456),
    ARGON2_TIME_COST: z.coerce.number().int().min(2).max(10).default(2),
    ARGON2_PARALLELISM: z.coerce.number().int().min(1).max(8).default(1),

    AUTH_REQUIRE_EMAIL_VERIFICATION: booleanFromString.default(true),
    // Requests per client IP to login/register per window.
    AUTH_IP_LIMIT: z.coerce.number().int().min(1).default(20),
    AUTH_IP_WINDOW_SECONDS: z.coerce.number().int().min(1).default(900),
    // Failed logins per email address per window, regardless of whether the account exists.
    AUTH_ACCOUNT_FAILURE_LIMIT: z.coerce.number().int().min(1).default(10),
    AUTH_ACCOUNT_FAILURE_WINDOW_SECONDS: z.coerce.number().int().min(1).default(900),
    // Emails per address per hour from resend-verification and forgot-password
    // (stops an attacker from mail-bombing someone through our app).
    AUTH_EMAIL_LIMIT_PER_HOUR: z.coerce.number().int().min(1).default(3),
    EMAIL_VERIFICATION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(240).default(30),

    // Encrypts TOTP seeds at rest (HKDF-derived AES-256-GCM key). Required:
    // the API must not start without it rather than store seeds in clear.
    MFA_ENCRYPTION_KEY: z.string().min(32, 'must be at least 32 characters'),
    MFA_ISSUER: z.string().min(1).max(40).default('StreamHub'),
    AUTH_MFA_FAILURE_LIMIT: z.coerce.number().int().min(1).default(10),
    AUTH_MFA_FAILURE_WINDOW_SECONDS: z.coerce.number().int().min(1).default(900),

    SMTP_HOST: z.string().min(1).default('127.0.0.1'),
    SMTP_PORT: port.default(1025),
    SMTP_SECURE: booleanFromString.default(false),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    MAIL_FROM: z.string().min(3).default('StreamHub <no-reply@streamhub.local>'),

    // Object storage (ADR-044). Locally: MinIO-compatible storage with an
    // endpoint and keys. On AWS: leave S3_ENDPOINT and both keys unset, and the
    // SDK uses the instance or task role, so there is no storage secret at all.
    S3_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
    S3_REGION: z.string().min(1).default('eu-west-1'),
    S3_FORCE_PATH_STYLE: booleanFromString.default(false),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    S3_BUCKET_UPLOADS: z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'must be a valid bucket name')
      .optional(),

    // Uploads. Parts must be at least 5 MiB (S3 rule, except the last one) and
    // an upload has at most 10,000 parts.
    UPLOAD_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1024 * 1024)
      .max(50 * 1024 ** 3)
      .default(2 * 1024 ** 3),
    UPLOAD_PART_SIZE_BYTES: z.coerce
      .number()
      .int()
      .min(5 * 1024 * 1024)
      .max(512 * 1024 * 1024)
      .default(16 * 1024 * 1024),
    UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    UPLOAD_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(72).default(24),

    // Playback (Phase 5): how long a signed media URL works. Long enough for a
    // film with seeking; the player asks for a new URL when one expires.
    PLAYBACK_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(43_200).default(3600),
  })
  .transform((env) => ({
    ...env,
    // API docs are on by default everywhere except production.
    API_DOCS_ENABLED: env.API_DOCS_ENABLED ?? env.NODE_ENV !== 'production',
    // Secure cookies are mandatory in production; locally the site is plain HTTP.
    COOKIE_SECURE: env.COOKIE_SECURE ?? env.NODE_ENV === 'production',
    // A default bucket name is convenient locally and wrong in production.
    S3_BUCKET_UPLOADS:
      env.S3_BUCKET_UPLOADS ?? (env.NODE_ENV === 'production' ? '' : 'streamhub-uploads'),
  }))
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.LOG_PRETTY) {
      ctx.addIssue({
        code: 'custom',
        path: ['LOG_PRETTY'],
        message: 'must be false in production (structured JSON logs only)',
      });
    }
    if (env.NODE_ENV === 'production' && !env.COOKIE_SECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: 'must be true in production',
      });
    }
    if (!env.S3_BUCKET_UPLOADS) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_BUCKET_UPLOADS'],
        message: 'is required in production',
      });
    }
    if (Boolean(env.S3_ACCESS_KEY_ID) !== Boolean(env.S3_SECRET_ACCESS_KEY)) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_ACCESS_KEY_ID'],
        message:
          'set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither (role credentials)',
      });
    }
    if (Math.ceil(env.UPLOAD_MAX_BYTES / env.UPLOAD_PART_SIZE_BYTES) > 10_000) {
      ctx.addIssue({
        code: 'custom',
        path: ['UPLOAD_PART_SIZE_BYTES'],
        message: 'too small for UPLOAD_MAX_BYTES (S3 allows at most 10,000 parts)',
      });
    }
    if (env.NODE_ENV === 'production' && !env.WEB_ORIGIN.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['WEB_ORIGIN'],
        message: 'must use https in production',
      });
    }
  });

export type AppConfig = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/**
 * Parses and validates configuration. Error messages name the variable and the
 * rule that failed, but never echo the supplied value (it may be a secret).
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const key = issue.path.join('.') || '(root)';
      const reason =
        issue.code === 'invalid_type' && issue.input === undefined ? 'is required' : issue.message;
      return `${key}: ${reason}`;
    });
    throw new ConfigError(issues);
  }
  return result.data;
}
