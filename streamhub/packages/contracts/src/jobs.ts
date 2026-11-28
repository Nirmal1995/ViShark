import { z } from 'zod';
import { objectIdSchema } from './catalog.ts';
import { VIDEO_MIME_TYPES } from './uploads.ts';

/**
 * Messages between the API and the worker (Phase 6, ADR-047). Both sides
 * validate them: a queue is an input like any other.
 *
 * The worker has no database access. The API enqueues `transcode` jobs; the
 * worker reports back through a second queue, and only the API writes the
 * results to MongoDB.
 */
export const QUEUE_NAMES = {
  transcode: 'video-transcode',
  results: 'video-results',
} as const;

/** Keys the API generates for uploads (`videos/<id>/source/<uuid>`). */
export const SOURCE_KEY_PATTERN = /^videos\/[a-f0-9]{24}\/source\/[0-9a-f-]{36}$/;

export const transcodeJobSchema = z.strictObject({
  videoId: objectIdSchema,
  sourceKey: z.string().regex(SOURCE_KEY_PATTERN),
  mimeType: z.enum(VIDEO_MIME_TYPES),
});
export type TranscodeJob = z.infer<typeof transcodeJobSchema>;

export const renditionSchema = z.strictObject({
  /** Directory name and label, e.g. `720p`. */
  name: z.string().regex(/^\d{3,4}p$/),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Peak bits per second, as advertised in the master playlist. */
  bandwidth: z.number().int().positive(),
});
export type Rendition = z.infer<typeof renditionSchema>;

const mediaKey = z.string().regex(/^videos\/[a-f0-9]{24}\/hls\/[0-9a-f-]{36}\/[\w./-]+$/);

export const transcodeResultSchema = z.discriminatedUnion('type', [
  /** The worker took the job: the video moves to PROCESSING. */
  z.strictObject({ type: z.literal('started'), videoId: objectIdSchema }),
  z.strictObject({
    type: z.literal('ready'),
    videoId: objectIdSchema,
    durationSeconds: z.number().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    /** Prefix holding the master playlist, one directory per rendition, and the poster. */
    hlsPrefix: z.string().regex(/^videos\/[a-f0-9]{24}\/hls\/[0-9a-f-]{36}$/),
    masterKey: mediaKey,
    posterKey: mediaKey,
    renditions: z.array(renditionSchema).min(1).max(8),
  }),
  /** Final: the file is not usable, or retries ran out. */
  z.strictObject({
    type: z.literal('failed'),
    videoId: objectIdSchema,
    reason: z.string().min(1).max(300),
  }),
]);
export type TranscodeResult = z.infer<typeof transcodeResultSchema>;
