import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { S3Client } from '@aws-sdk/client-s3';
import { transcodeJobSchema, type TranscodeJob, type TranscodeResult } from '@streamhub/contracts';
import { UnrecoverableError, type Job } from 'bullmq';
import type { Logger } from 'pino';
import type { WorkerConfig } from './config.ts';
import { planRenditions } from './ladder.ts';
import { InvalidMediaError, probe } from './probe.ts';
import { deleteKeys, download, uploadDirectory } from './storage.ts';
import { transcodeToHls } from './transcode.ts';

export type Report = (result: TranscodeResult) => Promise<void>;

type ProcessorConfig = Pick<
  WorkerConfig,
  | 'S3_BUCKET_UPLOADS'
  | 'S3_BUCKET_MEDIA'
  | 'WORKER_TMP_DIR'
  | 'FFMPEG_PRESET'
  | 'TRANSCODE_MAX_DURATION_SECONDS'
  | 'TRANSCODE_STEP_TIMEOUT_SECONDS'
>;

/** Short, safe reason for the video record: no paths, no stack traces. */
function reasonFor(err: unknown): string {
  if (err instanceof InvalidMediaError) return err.message;
  const message = err instanceof Error ? err.message : String(err);
  return `processing failed: ${message.replace(/\/[^\s:]+/g, '<path>')}`.slice(0, 300);
}

/**
 * Handles one transcode job: download the source, probe it, transcode every
 * rendition, upload the result under a fresh prefix, report back.
 *
 * Failure handling:
 *  - a file that cannot be processed (InvalidMediaError) fails at once
 *    (UnrecoverableError: no retries) and is reported as `failed`;
 *  - anything else is thrown so BullMQ retries with backoff; only the last
 *    attempt reports `failed`;
 *  - outputs of a failed attempt are deleted, so retries never mix files.
 */
export function createProcessor(deps: {
  s3: S3Client;
  config: ProcessorConfig;
  logger: Logger;
  report: Report;
}) {
  const { s3, config, logger, report } = deps;

  return async function processJob(job: Job): Promise<void> {
    const parsed = transcodeJobSchema.safeParse(job.data);
    if (!parsed.success) {
      // Not from our API: nothing sensible to report it against.
      throw new UnrecoverableError('invalid job payload');
    }
    const data: TranscodeJob = parsed.data;
    const log = logger.child({
      jobId: job.id,
      videoId: data.videoId,
      attempt: job.attemptsMade + 1,
    });
    const started = Date.now();
    await report({ type: 'started', videoId: data.videoId });

    const work = await mkdtemp(join(config.WORKER_TMP_DIR ?? tmpdir(), 'transcode-'));
    const hlsPrefix = `videos/${data.videoId}/hls/${randomUUID()}`;
    const written: string[] = [];
    try {
      const source = join(work, 'source');
      await download(s3, config.S3_BUCKET_UPLOADS, data.sourceKey, source);
      const media = await probe(
        source,
        config.TRANSCODE_MAX_DURATION_SECONDS,
        config.TRANSCODE_STEP_TIMEOUT_SECONDS,
      );
      const renditions = planRenditions(media, media.hasAudio);
      log.info(
        { event: 'transcode.start', media, renditions: renditions.map((r) => r.name) },
        'transcoding',
      );

      const out = join(work, 'out');
      await transcodeToHls(source, out, renditions, media, {
        preset: config.FFMPEG_PRESET,
        timeoutSeconds: config.TRANSCODE_STEP_TIMEOUT_SECONDS,
      });
      await uploadDirectory(s3, config.S3_BUCKET_MEDIA, out, hlsPrefix, written);

      await report({
        type: 'ready',
        videoId: data.videoId,
        durationSeconds: media.durationSeconds,
        width: media.width,
        height: media.height,
        hlsPrefix,
        masterKey: `${hlsPrefix}/master.m3u8`,
        posterKey: `${hlsPrefix}/poster.jpg`,
        renditions: renditions.map(({ name, width, height, bandwidth }) => ({
          name,
          width,
          height,
          bandwidth,
        })),
      });
      log.info(
        {
          event: 'transcode.done',
          seconds: Math.round((Date.now() - started) / 1000),
          files: written.length,
        },
        'transcoded',
      );
    } catch (err) {
      if (written.length) {
        await deleteKeys(s3, config.S3_BUCKET_MEDIA, written).catch((cleanupErr: unknown) =>
          log.warn({ err: cleanupErr }, 'could not delete partial output'),
        );
      }
      const permanent = err instanceof InvalidMediaError;
      const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      log.warn({ err, permanent, lastAttempt }, 'transcode failed');
      if (permanent || lastAttempt) {
        await report({ type: 'failed', videoId: data.videoId, reason: reasonFor(err) });
      }
      throw permanent ? new UnrecoverableError(reasonFor(err)) : err;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  };
}
