import { QUEUE_NAMES, transcodeResultSchema } from '@streamhub/contracts';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { loadConfig } from './config.ts';
import { createProcessor } from './processor.ts';
import { createS3Client } from './storage.ts';

/**
 * StreamHub worker (Phase 6, ADR-047): consumes `video-transcode` jobs and
 * reports to `video-results`. Locally it runs forever in Compose; on Fargate
 * it exits after WORKER_IDLE_EXIT_SECONDS with nothing to do, so the task
 * stops and costs nothing.
 */
const config = loadConfig();
const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'streamhub-worker', env: config.NODE_ENV },
  redact: ['err.config', 'err.$metadata', 'err.$response'],
});

// BullMQ needs blocking commands to wait for jobs indefinitely.
const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
connection.on('error', (err: Error) =>
  logger.warn({ err: { message: err.message } }, 'redis error'),
);

const results = new Queue(QUEUE_NAMES.results, { connection });
const transcode = new Queue(QUEUE_NAMES.transcode, { connection });
for (const q of [results, transcode]) {
  q.on('error', (err) => logger.warn({ err: { message: err.message } }, 'queue error'));
}

const processor = createProcessor({
  s3: createS3Client(config),
  config,
  logger,
  report: async (result) => {
    const message = transcodeResultSchema.parse(result);
    await results.add(message.type, message, {
      attempts: 10,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  },
});

const worker = new Worker(QUEUE_NAMES.transcode, processor, {
  connection,
  concurrency: config.WORKER_CONCURRENCY,
  // The lock is renewed while a job runs; if the task dies (Spot reclaim), the
  // job becomes "stalled" after this and another worker picks it up.
  lockDuration: 60_000,
  maxStalledCount: 2,
});

let running = 0;
let lastActivity = Date.now();
worker.on('active', () => {
  running += 1;
  lastActivity = Date.now();
});
const finished = () => {
  running = Math.max(0, running - 1);
  lastActivity = Date.now();
};
worker.on('completed', finished);
worker.on('failed', (job, err) => {
  finished();
  logger.warn(
    { jobId: job?.id, attempts: job?.attemptsMade, err: { message: err.message } },
    'job failed',
  );
});
worker.on('error', (err) => logger.error({ err }, 'worker error'));

let stopping = false;
async function shutdown(reason: string, code = 0) {
  if (stopping) return;
  stopping = true;
  logger.info({ reason }, 'stopping');
  // Waits for running jobs. On a Spot reclaim ECS sends SIGTERM and kills the
  // task about two minutes later; an unfinished job is retried elsewhere.
  await worker.close();
  await Promise.allSettled([results.close(), transcode.close()]);
  connection.disconnect();
  process.exit(code);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

if (config.WORKER_IDLE_EXIT_SECONDS > 0) {
  const idleMs = config.WORKER_IDLE_EXIT_SECONDS * 1000;
  setInterval(() => {
    if (stopping || running > 0 || Date.now() - lastActivity < idleMs) return;
    transcode
      .getJobCounts('waiting', 'delayed', 'prioritized', 'active')
      .then((counts) => {
        const pending = Object.values(counts).reduce((sum, n) => sum + n, 0);
        if (pending === 0) void shutdown('idle');
        else lastActivity = Date.now(); // work arrived or is still delayed: stay
      })
      .catch((err: unknown) => logger.warn({ err }, 'could not read the queue'));
  }, 5000).unref();
}

logger.info(
  {
    concurrency: config.WORKER_CONCURRENCY,
    idleExitSeconds: config.WORKER_IDLE_EXIT_SECONDS,
    preset: config.FFMPEG_PRESET,
  },
  'worker started',
);
