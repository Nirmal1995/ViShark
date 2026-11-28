import { PROCESSING_STATUSES, PUBLICATION_STATUSES, VISIBILITIES } from '@streamhub/shared';
import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

/**
 * videos collection: metadata only. The files live in private object storage
 * under generated keys (never user-supplied names). Lifecycle rules:
 * packages/shared/src/video-status.ts.
 *
 * Deletion is soft (deletedAt): the document disappears from every query at
 * once, and the storage objects are removed by a cleanup job afterwards, so a
 * crash between "delete row" and "delete files" cannot orphan files silently.
 */
const videoSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: '', maxlength: 5000 },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
    visibility: { type: String, enum: VISIBILITIES, required: true, default: 'PUBLIC' },
    publicationStatus: {
      type: String,
      enum: PUBLICATION_STATUSES,
      required: true,
      default: 'DRAFT',
    },
    processingStatus: {
      type: String,
      enum: PROCESSING_STATUSES,
      required: true,
      default: 'INITIATED',
    },
    /** Set by the upload and processing steps (Phase 4b and 6). */
    storageKey: { type: String, default: null },
    thumbnailKey: { type: String, default: null },
    mimeType: { type: String, default: null },
    sizeBytes: { type: Number, default: null, min: 0 },
    durationSeconds: { type: Number, default: null, min: 0 },
    width: { type: Number, default: null, min: 0 },
    height: { type: Number, default: null, min: 0 },
    failureReason: { type: String, default: null, maxlength: 300 },
    /** HLS output in the media bucket, written by the worker (Phase 6). */
    hlsPrefix: { type: String, default: null },
    hlsMasterKey: { type: String, default: null },
    renditions: {
      type: [
        new Schema(
          {
            name: { type: String, required: true },
            width: { type: Number, required: true },
            height: { type: Number, required: true },
            bandwidth: { type: Number, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    publishedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

// Catalogue: published, public, ready, newest first, optionally by category.
videoSchema.index({ publicationStatus: 1, visibility: 1, categoryId: 1, publishedAt: -1 });
// Management view and "videos in this category" checks.
videoSchema.index({ categoryId: 1, deletedAt: 1 });
videoSchema.index({ processingStatus: 1, updatedAt: 1 });
videoSchema.index({ createdAt: -1 });
// Search. One text index per collection; the title matters more than the description.
videoSchema.index(
  { title: 'text', description: 'text' },
  { weights: { title: 3, description: 1 }, name: 'video_text' },
);

export type Video = InferSchemaType<typeof videoSchema>;
export type VideoDocument = mongoose.HydratedDocument<Video>;
export const VideoModel: Model<Video> =
  (mongoose.models.Video as Model<Video> | undefined) ??
  mongoose.model<Video>('Video', videoSchema);
