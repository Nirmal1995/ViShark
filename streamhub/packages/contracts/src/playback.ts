import { z } from 'zod';
import { catalogueVideoDtoSchema, objectIdSchema } from './catalog.ts';

/**
 * Playback, watch history and favourites (Phase 5).
 *
 * The API authorises and hands out a short-lived signed media URL; storage
 * (later the CDN) serves the bytes, including range requests. The player
 * reports its position every 30 to 60 seconds, which powers "resume" and the
 * history list.
 */

/** 24 hours: longer than any film, short enough to reject nonsense. */
export const MAX_POSITION_SECONDS = 86_400;

export const progressBodySchema = z.strictObject({
  positionSeconds: z.number().min(0).max(MAX_POSITION_SECONDS).meta({ example: 754.2 }),
});
export type ProgressBody = z.infer<typeof progressBodySchema>;

export const playbackDtoSchema = z.object({
  videoId: objectIdSchema,
  /**
   * `hls`: adaptive streaming, once the worker has processed the video. The
   * URL is the API's master playlist; its media playlists carry signed
   * segment URLs. `source`: the uploaded file itself (progressive), used for
   * administrator previews before processing finishes.
   */
  kind: z.enum(['hls', 'source']),
  mimeType: z.string(),
  url: z.string().meta({
    description:
      'For hls: the master playlist (an API path; send the session cookie). For source: a signed storage URL that supports range requests (206).',
  }),
  expiresAt: z.iso.datetime().meta({
    description: 'Ask for a new URL after this (also when the player gets a 403).',
  }),
  durationSeconds: z.number().nullable(),
  /** Signed poster image URL, once the worker has made one. */
  posterUrl: z.string().nullable(),
  resumePositionSeconds: z.number(),
  /** True when an administrator previews a video viewers cannot watch yet. */
  preview: z.boolean(),
});
export type PlaybackDto = z.infer<typeof playbackDtoSchema>;

export const historyEntryDtoSchema = z.object({
  video: catalogueVideoDtoSchema,
  positionSeconds: z.number(),
  completed: z.boolean(),
  watchedAt: z.iso.datetime(),
});
export type HistoryEntryDto = z.infer<typeof historyEntryDtoSchema>;

export const favouriteDtoSchema = z.object({
  video: catalogueVideoDtoSchema,
  favouritedAt: z.iso.datetime(),
});
export type FavouriteDto = z.infer<typeof favouriteDtoSchema>;
