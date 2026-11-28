import type {
  FavouriteDto,
  HistoryEntryDto,
  PaginationQuery,
  PlaybackDto,
} from '@streamhub/contracts';
import { can, type ProcessingStatus } from '@streamhub/shared';
import type mongoose from 'mongoose';
import { Types, type PipelineStage } from 'mongoose';
import { notFound } from '../../common/errors.ts';
import { pageMeta, skipFor } from '../../common/pagination.ts';
import type { AppConfig } from '../../config/env.ts';
import type { ObjectStorage } from '../../infrastructure/storage.ts';
import type { AuthenticatedUser } from '../../middleware/authenticate.ts';
import { toCatalogueVideoDto } from '../videos/video.dto.ts';
import { VideoModel } from '../videos/video.model.ts';
import { WATCHABLE, withCategories, type LeanVideo } from '../videos/videos.service.ts';
import { FavouriteModel, WatchProgressModel } from './library.models.ts';

/** States in which the uploaded file exists and passed the upload checks. */
const PREVIEWABLE: readonly ProcessingStatus[] = ['VERIFYING', 'PROCESSING', 'READY'];

/** Segment file names the worker writes (seg_00000.ts). */
const SEGMENT_NAME = /^seg_\d{5}\.ts$/;

/** Watched this share of the video: counts as finished (credits do not need watching). */
const COMPLETED_SHARE = 0.95;

type PlaybackConfig = Pick<AppConfig, 'PLAYBACK_URL_TTL_SECONDS'>;

export type PlaybackService = ReturnType<typeof createPlaybackService>;

/**
 * Who may watch what:
 *  - anyone signed in: published, READY, not deleted (visibility only affects
 *    listing, so unlisted videos play by direct link);
 *  - `video:manage` additionally previews any video whose file was uploaded
 *    and verified, so administrators can check a video before publishing.
 * Everything else is a 404, never a 403: viewers learn nothing about drafts.
 */
export function createPlaybackService(deps: {
  storage: ObjectStorage;
  /** Media bucket with the worker's HLS output; absent until it exists. */
  media?: ObjectStorage;
  config: PlaybackConfig;
}) {
  const { storage, media, config } = deps;

  /** HLS is used once the worker has produced it and the media bucket is configured. */
  const hlsOf = (video: LeanVideo) =>
    media && video.processingStatus === 'READY' && video.hlsMasterKey && video.hlsPrefix
      ? { media, prefix: video.hlsPrefix, renditions: video.renditions ?? [] }
      : null;

  async function playable(user: AuthenticatedUser, videoId: string) {
    const video = await VideoModel.findOne({ _id: videoId, deletedAt: null }).lean<LeanVideo>();
    if (!video?.storageKey) throw notFound();
    const watchable = video.publicationStatus === 'PUBLISHED' && video.processingStatus === 'READY';
    const preview =
      !watchable && can(user.role, 'video:manage') && PREVIEWABLE.includes(video.processingStatus);
    if (!watchable && !preview) throw notFound();
    return { video, preview };
  }

  /** History and favourites list only what the user could still watch. */
  async function pageOfWatchable<T extends { videoId: Types.ObjectId }>(
    model: mongoose.Model<never>,
    userId: Types.ObjectId,
    sortField: 'updatedAt' | 'createdAt',
    page: PaginationQuery,
  ) {
    const pipeline: PipelineStage[] = [
      { $match: { userId } },
      { $sort: { [sortField]: -1, _id: -1 } },
      {
        $lookup: {
          from: VideoModel.collection.name,
          localField: 'videoId',
          foreignField: '_id',
          as: 'video',
          pipeline: [{ $match: WATCHABLE }],
        },
      },
      { $unwind: '$video' },
      {
        $facet: {
          items: [{ $skip: skipFor(page) }, { $limit: page.pageSize }],
          total: [{ $count: 'n' }],
        },
      },
    ];
    const [result] = await model.aggregate<{
      items: (T & { video: LeanVideo })[];
      total: { n: number }[];
    }>(pipeline);
    const items = result?.items ?? [];
    const categoryOf = await withCategories(items.map((i) => i.video));
    return {
      items: items.map((i) => ({
        entry: i,
        video: toCatalogueVideoDto(i.video, categoryOf(i.video)),
      })),
      meta: pageMeta(page, result?.total[0]?.n ?? 0),
    };
  }

  return {
    async getPlayback(user: AuthenticatedUser, videoId: string): Promise<PlaybackDto> {
      const { video, preview } = await playable(user, videoId);
      const ttl = config.PLAYBACK_URL_TTL_SECONDS;
      const hls = hlsOf(video);
      const [url, posterUrl, progress] = await Promise.all([
        hls
          ? Promise.resolve(`/api/v1/videos/${video._id.toString()}/hls/master.m3u8`)
          : storage.presignGet(video.storageKey!, ttl),
        hls && video.thumbnailKey ? hls.media.presignGet(video.thumbnailKey, ttl) : null,
        WatchProgressModel.findOne({ userId: user._id, videoId: video._id })
          .select('positionSeconds completed')
          .lean(),
      ]);
      return {
        videoId: video._id.toString(),
        kind: hls ? 'hls' : 'source',
        mimeType: hls
          ? 'application/vnd.apple.mpegurl'
          : (video.mimeType ?? 'application/octet-stream'),
        url,
        expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
        durationSeconds: video.durationSeconds ?? null,
        posterUrl,
        // A finished video starts again from the beginning.
        resumePositionSeconds: progress && !progress.completed ? progress.positionSeconds : 0,
        preview,
      };
    },

    /** The master playlist, built from the database: one entry per rendition. */
    async masterPlaylist(user: AuthenticatedUser, videoId: string): Promise<string> {
      const { video } = await playable(user, videoId);
      const hls = hlsOf(video);
      if (!hls) throw notFound();
      const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS'];
      for (const r of [...hls.renditions].sort((a, b) => b.bandwidth - a.bandwidth)) {
        lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth},RESOLUTION=${r.width}x${r.height}`);
        lines.push(`${r.name}/index.m3u8`); // relative: resolves to the API route below
      }
      return `${lines.join('\n')}\n`;
    },

    /**
     * A rendition's media playlist with every segment replaced by a signed
     * storage URL, so the player fetches segments straight from storage (later
     * the CDN) and only users allowed to watch get working URLs.
     */
    async mediaPlaylist(
      user: AuthenticatedUser,
      videoId: string,
      rendition: string,
    ): Promise<string> {
      const { video } = await playable(user, videoId);
      const hls = hlsOf(video);
      // Only names the worker reported: no path from the URL reaches storage.
      if (!hls || !hls.renditions.some((r) => r.name === rendition)) throw notFound();
      const text = await hls.media.getText(`${hls.prefix}/${rendition}/index.m3u8`, 1024 * 1024);
      const ttl = config.PLAYBACK_URL_TTL_SECONDS;
      const lines = await Promise.all(
        text.split('\n').map(async (raw) => {
          const line = raw.trim();
          if (!line || line.startsWith('#')) return line;
          if (!SEGMENT_NAME.test(line))
            throw new Error(`unexpected playlist entry in ${video._id.toString()}`);
          return hls.media.presignGet(`${hls.prefix}/${rendition}/${line}`, ttl);
        }),
      );
      return lines.join('\n');
    },

    async saveProgress(user: AuthenticatedUser, videoId: string, positionSeconds: number) {
      const { video } = await playable(user, videoId);
      const duration = video.durationSeconds ?? null;
      const position = duration ? Math.min(positionSeconds, duration) : positionSeconds;
      await WatchProgressModel.updateOne(
        { userId: user._id, videoId: video._id },
        {
          $set: {
            positionSeconds: position,
            completed: duration ? position >= duration * COMPLETED_SHARE : false,
          },
        },
        { upsert: true },
      );
    },

    async listHistory(
      userId: Types.ObjectId,
      page: PaginationQuery,
    ): Promise<{ items: HistoryEntryDto[]; meta: ReturnType<typeof pageMeta> }> {
      const { items, meta } = await pageOfWatchable<{
        videoId: Types.ObjectId;
        positionSeconds: number;
        completed: boolean;
        updatedAt: Date;
      }>(WatchProgressModel as unknown as mongoose.Model<never>, userId, 'updatedAt', page);
      return {
        items: items.map(({ entry, video }) => ({
          video,
          positionSeconds: entry.positionSeconds,
          completed: entry.completed,
          watchedAt: entry.updatedAt.toISOString(),
        })),
        meta,
      };
    },

    /** Idempotent: removing an entry that is not there is fine. */
    async removeHistory(userId: Types.ObjectId, videoId: string) {
      await WatchProgressModel.deleteOne({ userId, videoId });
    },

    /** Idempotent. Only watchable videos can be saved. */
    async addFavourite(userId: Types.ObjectId, videoId: string) {
      if (!(await VideoModel.exists({ _id: videoId, ...WATCHABLE }))) throw notFound();
      await FavouriteModel.updateOne(
        { userId, videoId },
        { $setOnInsert: { userId, videoId: new Types.ObjectId(videoId) } },
        { upsert: true },
      );
    },

    async removeFavourite(userId: Types.ObjectId, videoId: string) {
      await FavouriteModel.deleteOne({ userId, videoId });
    },

    async listFavourites(
      userId: Types.ObjectId,
      page: PaginationQuery,
    ): Promise<{ items: FavouriteDto[]; meta: ReturnType<typeof pageMeta> }> {
      const { items, meta } = await pageOfWatchable<{
        videoId: Types.ObjectId;
        createdAt: Date;
      }>(FavouriteModel as unknown as mongoose.Model<never>, userId, 'createdAt', page);
      return {
        items: items.map(({ entry, video }) => ({
          video,
          favouritedAt: entry.createdAt.toISOString(),
        })),
        meta,
      };
    },
  };
}
