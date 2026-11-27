import { UPLOAD_STATUSES, VIDEO_MIME_TYPES } from '@streamhub/contracts';
import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

/**
 * uploads collection: one multipart upload per video.
 *
 *   ACTIVE ──► COMPLETING ──► COMPLETED
 *     │            │  └──► ACTIVE (storage rejected the parts; the client may retry)
 *     │            └─────► FAILED   (wrong size or not a video; the file is deleted)
 *     ├──► ABORTED  (admin cancelled)
 *     └──► EXPIRED  (abandoned; swept by expireStaleUploads)
 *
 * COMPLETING is a short-lived lock so two "complete" calls cannot both run.
 * storageUploadId is the S3 multipart UploadId: kept server-side only.
 */
const uploadSchema = new Schema(
  {
    videoId: { type: Schema.Types.ObjectId, ref: 'Video', required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    bucket: { type: String, required: true },
    key: { type: String, required: true },
    storageUploadId: { type: String, required: true },
    mimeType: { type: String, enum: VIDEO_MIME_TYPES, required: true },
    sizeBytes: { type: Number, required: true, min: 1 },
    partSizeBytes: { type: Number, required: true, min: 1 },
    partCount: { type: Number, required: true, min: 1 },
    status: { type: String, enum: UPLOAD_STATUSES, required: true, default: 'ACTIVE' },
    expiresAt: { type: Date, required: true },
    completedAt: { type: Date, default: null },
    failureReason: { type: String, default: null, maxlength: 300 },
  },
  { timestamps: true, versionKey: false },
);

// One upload per video, ever: a cancelled or expired upload ends the video's
// lifecycle (ABORTED), and the admin creates a new video to try again.
uploadSchema.index({ videoId: 1 }, { unique: true });
// The expiry sweep.
uploadSchema.index({ status: 1, expiresAt: 1 });

export type Upload = InferSchemaType<typeof uploadSchema>;
export const UploadModel: Model<Upload> =
  (mongoose.models.Upload as Model<Upload> | undefined) ??
  mongoose.model<Upload>('Upload', uploadSchema);
