import type {
  AdminVideosQuery,
  CatalogueQuery,
  CreateVideoBody,
  UpdateVideoBody,
} from '@streamhub/contracts';
import {
  processingStatesBefore,
  publicationStatesBefore,
  type ProcessingStatus,
  type PublicationStatus,
} from '@streamhub/shared';
import mongoose, { type Types } from 'mongoose';
import { AppError, badRequest, notFound } from '../../common/errors.ts';
import { pageMeta, skipFor } from '../../common/pagination.ts';
import { CategoryModel } from '../categories/category.model.ts';
import { toAdminVideoDto, toCatalogueVideoDto } from './video.dto.ts';
import { VideoModel, type Video } from './video.model.ts';

type LeanVideo = Video & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

/** What a viewer may watch: published, processed, not deleted. Visibility only affects listing. */
const WATCHABLE = {
  deletedAt: null,
  publicationStatus: 'PUBLISHED' as const,
  processingStatus: 'READY' as const,
};
/** What the catalogue lists. */
const LISTED = { ...WATCHABLE, visibility: 'PUBLIC' as const };

const invalidTransition = (details: Record<string, string>) =>
  new AppError(409, 'INVALID_TRANSITION', 'This status change is not allowed', details);

async function assertCategory(categoryId: string | null | undefined): Promise<void> {
  if (!categoryId) return;
  if (!(await CategoryModel.exists({ _id: categoryId }))) {
    throw badRequest('Request validation failed', [
      { location: 'body', path: 'categoryId', message: 'category does not exist' },
    ]);
  }
}

/** Loads the categories for a page of videos in one query, instead of one per video. */
async function withCategories(videos: LeanVideo[]) {
  const ids = [...new Set(videos.map((v) => v.categoryId?.toString()).filter(Boolean))];
  const categories = ids.length
    ? await CategoryModel.find({ _id: mongoose.trusted({ $in: ids }) })
        .select('name slug')
        .lean()
    : [];
  const byId = new Map(categories.map((c) => [c._id.toString(), c]));
  return (video: LeanVideo) => {
    const c = video.categoryId ? byId.get(video.categoryId.toString()) : undefined;
    return c ? { id: c._id.toString(), name: c.name, slug: c.slug } : null;
  };
}

function searchFilter(q: string | undefined): Record<string, unknown> {
  // $text is an operator the server builds on purpose (sanitizeFilter would
  // otherwise neutralise it); the search string itself is plain data.
  return q ? { $text: mongoose.trusted({ $search: q }) } : {};
}

async function page(
  filter: Record<string, unknown>,
  query: CatalogueQuery,
  sort: Record<string, 1 | -1>,
) {
  const [videos, total] = await Promise.all([
    VideoModel.find(filter)
      .sort(sort)
      .skip(skipFor(query))
      .limit(query.pageSize)
      .lean<LeanVideo[]>(),
    VideoModel.countDocuments(filter),
  ]);
  return { videos, meta: pageMeta(query, total) };
}

export async function listCatalogue(query: CatalogueQuery) {
  const filter = {
    ...LISTED,
    ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    ...searchFilter(query.q),
  };
  const { videos, meta } = await page(filter, query, { publishedAt: -1, _id: -1 });
  const category = await withCategories(videos);
  return { items: videos.map((v) => toCatalogueVideoDto(v, category(v))), meta };
}

export async function listForAdmin(query: AdminVideosQuery) {
  const filter: Record<string, unknown> = { deletedAt: null, ...searchFilter(query.q) };
  if (query.categoryId) filter.categoryId = query.categoryId;
  if (query.publicationStatus) filter.publicationStatus = query.publicationStatus;
  if (query.processingStatus) filter.processingStatus = query.processingStatus;
  const { videos, meta } = await page(filter, query, { createdAt: -1, _id: -1 });
  const category = await withCategories(videos);
  return { items: videos.map((v) => toAdminVideoDto(v, category(v))), meta };
}

/**
 * One video. Viewers get 404 for anything they may not watch, so they cannot
 * tell a draft from an id that does not exist.
 */
export async function getVideo(id: string, asAdmin: boolean) {
  const video = await VideoModel.findOne({
    _id: id,
    ...(asAdmin ? { deletedAt: null } : WATCHABLE),
  }).lean<LeanVideo>();
  if (!video) throw notFound();
  const category = (await withCategories([video]))(video);
  return asAdmin ? toAdminVideoDto(video, category) : toCatalogueVideoDto(video, category);
}

export async function createVideo(ownerId: Types.ObjectId, body: CreateVideoBody) {
  await assertCategory(body.categoryId);
  const video = await VideoModel.create({
    title: body.title,
    description: body.description,
    categoryId: body.categoryId,
    visibility: body.visibility,
    ownerId,
  });
  const lean = video.toObject() as LeanVideo;
  return toAdminVideoDto(lean, (await withCategories([lean]))(lean));
}

export async function updateVideo(id: string, body: UpdateVideoBody) {
  await assertCategory(body.categoryId);
  // Explicit field list: status, owner and storage fields cannot be set here.
  const set: Record<string, unknown> = {};
  for (const key of ['title', 'description', 'categoryId', 'visibility'] as const) {
    if (body[key] !== undefined) set[key] = body[key];
  }
  const video = await VideoModel.findOneAndUpdate(
    { _id: id, deletedAt: null },
    { $set: set },
    { returnDocument: 'after', runValidators: true },
  ).lean<LeanVideo>();
  if (!video) throw notFound();
  return {
    video: toAdminVideoDto(video, (await withCategories([video]))(video)),
    changed: Object.keys(set),
  };
}

async function explainFailedTransition(id: string, to: string): Promise<never> {
  const current = await VideoModel.findOne({ _id: id, deletedAt: null })
    .select('publicationStatus processingStatus')
    .lean();
  if (!current) throw notFound();
  throw invalidTransition({
    to,
    publicationStatus: current.publicationStatus,
    processingStatus: current.processingStatus,
  });
}

/**
 * Changes the publication status atomically: the update only matches a video
 * that is currently in an allowed state, so two concurrent requests cannot
 * both succeed and a stale page cannot publish an archived video.
 */
export async function changePublication(
  id: string,
  to: PublicationStatus,
  /** Narrower than the state machine: "unpublish" only from PUBLISHED, "restore" only from ARCHIVED. */
  from: PublicationStatus | null = null,
) {
  const allowed = publicationStatesBefore(to).filter((s) => from === null || s === from);
  const filter: Record<string, unknown> = {
    _id: id,
    deletedAt: null,
    publicationStatus: mongoose.trusted({ $in: allowed }),
  };
  if (to === 'PUBLISHED') filter.processingStatus = 'READY';
  const before = await VideoModel.findOneAndUpdate(
    filter,
    { $set: { publicationStatus: to, publishedAt: to === 'PUBLISHED' ? new Date() : null } },
    { returnDocument: 'before', projection: { publicationStatus: 1 } },
  ).lean();
  if (!before) return explainFailedTransition(id, to);
  return { from: before.publicationStatus, to };
}

/** Same guarantee for processing states; used by uploads (4b) and the worker (6). */
export async function changeProcessing(
  id: string,
  to: ProcessingStatus,
  extra: Partial<
    Pick<
      Video,
      | 'storageKey'
      | 'mimeType'
      | 'sizeBytes'
      | 'durationSeconds'
      | 'width'
      | 'height'
      | 'thumbnailKey'
      | 'failureReason'
    >
  > = {},
) {
  const before = await VideoModel.findOneAndUpdate(
    {
      _id: id,
      deletedAt: null,
      processingStatus: mongoose.trusted({ $in: processingStatesBefore(to) }),
    },
    { $set: { ...extra, processingStatus: to } },
    { returnDocument: 'before', projection: { processingStatus: 1 } },
  ).lean();
  if (!before) return explainFailedTransition(id, to);
  return { from: before.processingStatus, to };
}

export async function softDeleteVideo(id: string) {
  const video = await VideoModel.findOneAndUpdate(
    { _id: id, deletedAt: null },
    // Unpublish at the same moment, so nothing can serve it between the two.
    { $set: { deletedAt: new Date(), publicationStatus: 'DRAFT', publishedAt: null } },
    { projection: { title: 1 } },
  ).lean();
  if (!video) throw notFound();
  return { title: video.title };
}
