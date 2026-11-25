import type { Types } from 'mongoose';
import type { Video } from './video.model.ts';

type CategoryRef = { id: string; name: string; slug: string } | null;
type VideoLike = Video & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/**
 * What viewers see. Storage keys, owner, failure details and internal states
 * never leave the API.
 */
export function toCatalogueVideoDto(video: VideoLike, category: CategoryRef) {
  return {
    id: video._id.toString(),
    title: video.title,
    description: video.description,
    category,
    durationSeconds: video.durationSeconds ?? null,
    width: video.width ?? null,
    height: video.height ?? null,
    publishedAt: iso(video.publishedAt),
  };
}

/** What administrators see: every state and technical detail, still no storage keys. */
export function toAdminVideoDto(video: VideoLike, category: CategoryRef) {
  return {
    ...toCatalogueVideoDto(video, category),
    ownerId: video.ownerId.toString(),
    visibility: video.visibility,
    publicationStatus: video.publicationStatus,
    processingStatus: video.processingStatus,
    mimeType: video.mimeType ?? null,
    sizeBytes: video.sizeBytes ?? null,
    failureReason: video.failureReason ?? null,
    hasFile: Boolean(video.storageKey),
    hasThumbnail: Boolean(video.thumbnailKey),
    createdAt: video.createdAt.toISOString(),
    updatedAt: video.updatedAt.toISOString(),
  };
}

export type CatalogueVideoDto = ReturnType<typeof toCatalogueVideoDto>;
export type AdminVideoDto = ReturnType<typeof toAdminVideoDto>;
