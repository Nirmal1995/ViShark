import {
  QUEUE_NAMES,
  transcodeResultSchema,
  type TranscodeJob,
  type TranscodeResult,
} from '@streamhub/contracts';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import mongoose from 'mongoose';
import type { Logger } from 'pino';
import { AppError } from '../../common/errors.ts';
import type { AppConfig } from '../../config/env.ts';
import { auditSystem } from '../audit/audit.service.ts';
import { VideoModel } from '../videos/video.model.ts';
import { changeProcessing } from '../videos/videos.service.ts';

/**
 * Starts worker capacity when jobs are waiting. Locally the worker always
 * runs (Compose), so this does nothing; on AWS it starts Fargate tasks
 * (Phase 6b).
 */
export interface WorkerLauncher {
  ensureRunning(waitingJobs: number): Promise<void>;
}
export const noLauncher: WorkerLauncher = { ensureRunning: async () => {} };

type ProcessingConfig = Pick<AppConfig, 'TRANSCODE_ATTEMPTS' | 'TRANSCODE_STUCK_MINUTES'>;

export type ProcessingService = ReturnType<typeof createProcessingService>;

/**
 * The API's half of video processing (ADR-047):
 *  - enqueue a transcode job once an upload is verified (job id = video id,
 *    so a video can only ever have one job in the queue);
 *  - consume the worker's results and record them: the worker itself has no
 *    database access;
 *  - recover from lost messages: re-enqueue verified videos without a job,
 *    fail videos whose processing died without a report.
 */
export function createProcessingService(deps: {
  connection: ConnectionOptions;
  config: ProcessingConfig;
  logger: Logger;
  launcher?: WorkerLauncher;
}) {
  const { connection, config } = deps;
  const logger = deps.logger.child({ component: 'processing' });
  const launcher = deps.launcher ?? noLauncher;
  const queue = new Queue<TranscodeJob>(QUEUE_NAMES.transcode, { connection });
  // An unhandled 'error' event would crash the process; Redis outages are
  // already reported by readiness and the connection logger.
  queue.on('error', (err) => logger.warn({ err: { message: err.message } }, 'queue error'));
  let resultsWorker: Worker | null = null;

  async function wakeWorkers() {
    const waiting = await queue.getJobCountByTypes('waiting', 'prioritized');
    if (waiting > 0) await launcher.ensureRunning(waiting);
  }

  /** Status changes that already happened (duplicates, races) are fine. */
  async function transition(
    videoId: string,
    to: 'PROCESSING' | 'READY' | 'FAILED',
    fields: Parameters<typeof changeProcessing>[2] = {},
  ): Promise<boolean> {
    try {
      await changeProcessing(videoId, to, fields);
      return true;
    } catch (err) {
      if (err instanceof AppError && (err.status === 404 || err.code === 'INVALID_TRANSITION')) {
        logger.info({ videoId, to, reason: err.code }, 'result ignored');
        return false;
      }
      throw err;
    }
  }

  async function handleResult(raw: unknown): Promise<void> {
    const result: TranscodeResult = transcodeResultSchema.parse(raw);
    const { videoId } = result;
    switch (result.type) {
      case 'started':
        await transition(videoId, 'PROCESSING');
        return;
      case 'ready': {
        const changed = await transition(videoId, 'READY', {
          durationSeconds: result.durationSeconds,
          width: result.width,
          height: result.height,
          hlsPrefix: result.hlsPrefix,
          hlsMasterKey: result.masterKey,
          thumbnailKey: result.posterKey,
          // Plain objects; Mongoose turns them into the subdocument array.
          renditions: result.renditions as unknown as NonNullable<
            Parameters<typeof changeProcessing>[2]
          >['renditions'],
          failureReason: null,
        });
        if (changed) {
          await auditSystem({
            action: 'video.processing_ready',
            targetType: 'video',
            targetId: videoId,
            details: {
              renditions: result.renditions.map((r) => r.name).join(','),
              durationSeconds: result.durationSeconds,
            },
          });
        }
        return;
      }
      case 'failed': {
        const changed = await transition(videoId, 'FAILED', { failureReason: result.reason });
        if (changed) {
          await auditSystem({
            action: 'video.processing_failed',
            targetType: 'video',
            targetId: videoId,
            details: { reason: result.reason },
          });
        }
        return;
      }
    }
  }

  return {
    queue,

    async enqueue(video: { id: string; storageKey: string; mimeType: string }): Promise<void> {
      await queue.add(
        'transcode',
        {
          videoId: video.id,
          sourceKey: video.storageKey,
          mimeType: video.mimeType,
        } as TranscodeJob,
        {
          jobId: video.id,
          attempts: config.TRANSCODE_ATTEMPTS,
          backoff: { type: 'exponential', delay: 60_000 },
          removeOnComplete: { count: 1000 },
          removeOnFail: { count: 5000 },
        },
      );
      logger.info({ event: 'transcode.enqueued', videoId: video.id }, 'transcode job queued');
      await wakeWorkers();
    },

    handleResult,

    /** Consumes the worker's reports, one at a time, in order. */
    startResultsConsumer() {
      resultsWorker = new Worker(
        QUEUE_NAMES.results,
        async (job) => {
          await handleResult(job.data);
        },
        { connection, concurrency: 1 },
      );
      resultsWorker.on('failed', (job, err) =>
        logger.error({ jobId: job?.id, err: { message: err.message } }, 'result not recorded'),
      );
      resultsWorker.on('error', (err) => logger.error({ err }, 'results consumer error'));
    },

    /**
     * Safety net for lost messages, run every few minutes:
     *  - VERIFYING for a while and no job: queue it (again);
     *  - VERIFYING or PROCESSING whose job ended without a report (worker
     *    killed on its last attempt): mark FAILED;
     *  - PROCESSING far longer than any transcode should take: same.
     */
    async recoverStuck(now = new Date()): Promise<{ requeued: number; failed: number }> {
      let requeued = 0;
      let failed = 0;
      const verifyingBefore = new Date(now.getTime() - 10 * 60_000);
      const processingBefore = new Date(now.getTime() - config.TRANSCODE_STUCK_MINUTES * 60_000);
      const stuck = await VideoModel.find({
        deletedAt: null,
        $or: [
          { processingStatus: 'VERIFYING', updatedAt: mongoose.trusted({ $lt: verifyingBefore }) },
          {
            processingStatus: 'PROCESSING',
            updatedAt: mongoose.trusted({ $lt: processingBefore }),
          },
        ],
      })
        .select('processingStatus storageKey mimeType')
        .limit(100)
        .lean();

      for (const video of stuck) {
        const id = video._id.toString();
        const job = await queue.getJob(id);
        const state = job ? await job.getState() : 'missing';
        if (
          state === 'waiting' ||
          state === 'delayed' ||
          state === 'active' ||
          state === 'prioritized'
        ) {
          continue; // still in the queue: give it time
        }
        if (state === 'missing' && video.processingStatus === 'VERIFYING' && video.storageKey) {
          await this.enqueue({
            id,
            storageKey: video.storageKey,
            mimeType: video.mimeType ?? 'video/mp4',
          });
          requeued += 1;
          continue;
        }
        if (
          await transition(id, 'FAILED', {
            failureReason: 'processing did not finish; upload the video again',
          })
        ) {
          await auditSystem({
            action: 'video.processing_failed',
            targetType: 'video',
            targetId: id,
            details: { reason: `recovered: job ${state}` },
          });
          failed += 1;
        }
      }
      if (requeued || failed)
        logger.warn({ event: 'processing.recovered', requeued, failed }, 'recovered stuck videos');
      await wakeWorkers();
      return { requeued, failed };
    },

    async close() {
      await Promise.allSettled([resultsWorker?.close(), queue.close()]);
    },
  };
}
