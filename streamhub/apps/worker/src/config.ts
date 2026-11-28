import { z } from 'zod';

const booleanFromString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

/**
 * Worker configuration (ADR-047). The worker needs Redis (the queues) and
 * object storage only: no database URL, no session or mail secrets.
 */
const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    REDIS_URL: z.string().regex(/^rediss?:\/\//, 'must start with redis:// or rediss://'),

    // Same rules as the API: endpoint and keys locally, role credentials on AWS.
    S3_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
    S3_REGION: z.string().min(1).default('eu-west-1'),
    S3_FORCE_PATH_STYLE: booleanFromString.default(false),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    S3_BUCKET_UPLOADS: z.string().min(3).default('streamhub-uploads'),
    S3_BUCKET_MEDIA: z.string().min(3).default('streamhub-media'),

    /** Jobs at once. FFmpeg already uses every core, so 1 is right for a 2 vCPU task. */
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
    /**
     * Exit after this long with nothing to do (Fargate: the task stops and
     * costs nothing). 0 = run forever (local Compose).
     */
    WORKER_IDLE_EXIT_SECONDS: z.coerce.number().int().min(0).max(3600).default(0),
    WORKER_TMP_DIR: z.string().min(1).optional(),

    /** x264 speed/quality trade-off. veryfast: about 2 to 3 times quicker than medium. */
    FFMPEG_PRESET: z
      .enum(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'])
      .default('veryfast'),
    /** Refuse longer sources (cost and abuse guard). */
    TRANSCODE_MAX_DURATION_SECONDS: z.coerce.number().int().min(1).max(86_400).default(14_400),
    /** Kill a single FFmpeg run that takes longer than this. */
    TRANSCODE_STEP_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(21_600).default(3600),
  })
  .superRefine((env, ctx) => {
    if (Boolean(env.S3_ACCESS_KEY_ID) !== Boolean(env.S3_SECRET_ACCESS_KEY)) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_ACCESS_KEY_ID'],
        message:
          'set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither (role credentials)',
      });
    }
  });

export type WorkerConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}
