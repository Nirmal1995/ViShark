import { randomUUID } from 'node:crypto';
import type {
  CompleteUploadBody,
  PartUrlsDto,
  StartUploadBody,
  UploadDto,
  UploadSessionDto,
} from '@streamhub/contracts';
import mongoose, { type Types } from 'mongoose';
import type { Logger } from 'pino';
import { AppError, badRequest, notFound } from '../../common/errors.ts';
import type { AppConfig } from '../../config/env.ts';
import { StorageRejectedError, type ObjectStorage } from '../../infrastructure/storage.ts';
import { auditSystem } from '../audit/audit.service.ts';
import { VideoModel } from '../videos/video.model.ts';
import { changeProcessing } from '../videos/videos.service.ts';
import { matchesDeclaredType, SIGNATURE_BYTES } from './file-signature.ts';
import { UploadModel, type Upload } from './upload.model.ts';

type UploadsConfig = Pick<
  AppConfig,
  | 'UPLOAD_MAX_BYTES'
  | 'UPLOAD_PART_SIZE_BYTES'
  | 'UPLOAD_URL_TTL_SECONDS'
  | 'UPLOAD_SESSION_TTL_HOURS'
>;

type LeanUpload = Upload & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

const uploadNotActive = (status: string) =>
  new AppError(409, 'UPLOAD_NOT_ACTIVE', 'This upload is no longer in progress', { status });
const uploadExpired = () =>
  new AppError(410, 'UPLOAD_EXPIRED', 'This upload has expired; create a new video to try again');
const verificationFailed = (reason: string) =>
  new AppError(422, 'UPLOAD_VERIFICATION_FAILED', 'The uploaded file was rejected', { reason });

function toUploadDto(upload: LeanUpload): UploadDto {
  return {
    id: upload._id.toString(),
    videoId: upload.videoId.toString(),
    status: upload.status,
    mimeType: upload.mimeType,
    sizeBytes: upload.sizeBytes,
    partSizeBytes: upload.partSizeBytes,
    partCount: upload.partCount,
    expiresAt: upload.expiresAt.toISOString(),
    createdAt: upload.createdAt.toISOString(),
  };
}

/** S3 wants the ETag exactly as it returned it (quoted); browsers may drop the quotes. */
function normaliseEtag(etag: string): string {
  return `"${etag.replace(/"/g, '')}"`;
}

function isDuplicateKey(err: unknown): boolean {
  return err instanceof mongoose.mongo.MongoServerError && err.code === 11000;
}

export type UploadsService = ReturnType<typeof createUploadsService>;

export function createUploadsService(deps: {
  storage: ObjectStorage;
  config: UploadsConfig;
  logger: Logger;
  /** Called once a file is verified: queues processing (Phase 6). */
  onVerified?: (video: { id: string; storageKey: string; mimeType: string }) => Promise<void>;
}) {
  const { storage, config, logger } = deps;

  async function signParts(upload: LeanUpload, partNumbers: number[]) {
    const ttl = config.UPLOAD_URL_TTL_SECONDS;
    const urlsExpireAt = new Date(Date.now() + ttl * 1000).toISOString();
    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await storage.presignUploadPart(upload.key, upload.storageUploadId, partNumber, ttl),
      })),
    );
    return { parts, urlsExpireAt };
  }

  /** Why an upload could not be claimed: no upload, expired, or finished. */
  async function explainNotActive(videoId: string): Promise<never> {
    const video = await VideoModel.exists({ _id: videoId, deletedAt: null });
    if (!video) throw notFound();
    const upload = await UploadModel.findOne({ videoId }).select('status expiresAt').lean();
    if (!upload) throw notFound('This video has no upload');
    if (upload.status === 'ACTIVE' && upload.expiresAt <= new Date()) throw uploadExpired();
    throw uploadNotActive(upload.status);
  }

  async function activeUpload(videoId: string): Promise<LeanUpload> {
    const upload = await UploadModel.findOne({
      videoId,
      status: 'ACTIVE',
      expiresAt: mongoose.trusted({ $gt: new Date() }),
    }).lean<LeanUpload>();
    if (!upload) return explainNotActive(videoId);
    const video = await VideoModel.exists({ _id: videoId, deletedAt: null });
    if (!video) throw notFound();
    return upload;
  }

  /** Ends an upload whose file turned out to be wrong: delete it, fail the video. */
  async function rejectFile(upload: LeanUpload, reason: string): Promise<never> {
    await storage.delete(upload.key);
    await UploadModel.updateOne(
      { _id: upload._id },
      { $set: { status: 'FAILED', failureReason: reason } },
    );
    await changeProcessing(upload.videoId.toString(), 'FAILED', { failureReason: reason });
    await auditSystem({
      action: 'video.upload_rejected',
      targetType: 'video',
      targetId: upload.videoId,
      details: { reason },
    });
    throw verificationFailed(reason);
  }

  return {
    /**
     * Starts the multipart upload for a video in INITIATED and returns
     * pre-signed URLs for every part. The video moves to UPLOADING.
     */
    async start(actorId: Types.ObjectId, videoId: string, body: StartUploadBody) {
      const video = await VideoModel.findOne({ _id: videoId, deletedAt: null })
        .select('processingStatus publicationStatus')
        .lean();
      if (!video) throw notFound();
      if (video.processingStatus !== 'INITIATED') {
        throw new AppError(409, 'INVALID_TRANSITION', 'This status change is not allowed', {
          to: 'UPLOADING',
          publicationStatus: video.publicationStatus,
          processingStatus: video.processingStatus,
        });
      }
      if (body.sizeBytes > config.UPLOAD_MAX_BYTES) {
        throw new AppError(413, 'UPLOAD_TOO_LARGE', 'The file is larger than allowed', {
          maxBytes: config.UPLOAD_MAX_BYTES,
        });
      }

      const partSizeBytes = config.UPLOAD_PART_SIZE_BYTES;
      const partCount = Math.ceil(body.sizeBytes / partSizeBytes);
      // Generated key: user input never becomes part of a storage path.
      const key = `videos/${videoId}/source/${randomUUID()}`;
      const storageUploadId = await storage.createMultipartUpload(key, body.mimeType);

      let upload: LeanUpload;
      try {
        const created = await UploadModel.create({
          videoId,
          createdBy: actorId,
          bucket: storage.bucket,
          key,
          storageUploadId,
          mimeType: body.mimeType,
          sizeBytes: body.sizeBytes,
          partSizeBytes,
          partCount,
          expiresAt: new Date(Date.now() + config.UPLOAD_SESSION_TTL_HOURS * 3600 * 1000),
        });
        upload = created.toObject();
      } catch (err) {
        await storage.abortMultipartUpload(key, storageUploadId);
        // Lost a race with a concurrent start for the same video.
        if (isDuplicateKey(err)) throw uploadNotActive('ACTIVE');
        throw err;
      }

      try {
        await changeProcessing(videoId, 'UPLOADING', {
          storageKey: key,
          mimeType: body.mimeType,
          sizeBytes: body.sizeBytes,
        });
      } catch (err) {
        // The video changed between the check and now (deleted, or another request).
        await UploadModel.updateOne(
          { _id: upload._id },
          { $set: { status: 'ABORTED', failureReason: 'video changed during start' } },
        );
        await storage.abortMultipartUpload(key, storageUploadId);
        throw err;
      }

      const signed = await signParts(
        upload,
        Array.from({ length: partCount }, (_, i) => i + 1),
      );
      const session: UploadSessionDto = { ...toUploadDto(upload), ...signed };
      return session;
    },

    async get(videoId: string): Promise<UploadDto> {
      if (!(await VideoModel.exists({ _id: videoId, deletedAt: null }))) throw notFound();
      const upload = await UploadModel.findOne({ videoId }).lean<LeanUpload>();
      if (!upload) throw notFound('This video has no upload');
      return toUploadDto(upload);
    },

    /** Fresh URLs for parts whose URLs expired before the browser got to them. */
    async partUrls(videoId: string, partNumbers: number[]): Promise<PartUrlsDto> {
      const upload = await activeUpload(videoId);
      const outOfRange = partNumbers.filter((n) => n > upload.partCount);
      if (outOfRange.length) {
        throw badRequest('Request validation failed', [
          {
            location: 'body',
            path: 'partNumbers',
            message: `this upload has ${upload.partCount} parts`,
          },
        ]);
      }
      return signParts(upload, partNumbers);
    },

    /**
     * Finishes the multipart upload and verifies the result: the object
     * exists, has exactly the declared size, and starts with the signature of
     * the declared container. Then the video moves to VERIFYING, ready for the
     * worker. A wrong file is deleted and the video fails.
     */
    async complete(videoId: string, body: CompleteUploadBody): Promise<UploadDto> {
      // Claim the upload: only one "complete" can move it out of ACTIVE.
      const upload = await UploadModel.findOneAndUpdate(
        { videoId, status: 'ACTIVE', expiresAt: mongoose.trusted({ $gt: new Date() }) },
        { $set: { status: 'COMPLETING' } },
        { returnDocument: 'after' },
      ).lean<LeanUpload>();
      if (!upload) return explainNotActive(videoId);
      const release = () =>
        UploadModel.updateOne(
          { _id: upload._id, status: 'COMPLETING' },
          { $set: { status: 'ACTIVE' } },
        );

      const parts = [...body.parts].sort((a, b) => a.partNumber - b.partNumber);
      const complete =
        parts.length === upload.partCount && parts.every((p, i) => p.partNumber === i + 1);
      if (!complete) {
        await release();
        throw badRequest('Request validation failed', [
          {
            location: 'body',
            path: 'parts',
            message: `expected parts 1 to ${upload.partCount}, each exactly once`,
          },
        ]);
      }

      try {
        await storage.completeMultipartUpload(
          upload.key,
          upload.storageUploadId,
          parts.map((p) => ({ partNumber: p.partNumber, etag: normaliseEtag(p.etag) })),
        );
      } catch (err) {
        await release();
        if (err instanceof StorageRejectedError) {
          throw new AppError(
            400,
            'UPLOAD_PARTS_REJECTED',
            'Storage rejected the parts: check the ETags and that every part was uploaded',
          );
        }
        throw err;
      }

      const stored = await storage.head(upload.key);
      if (!stored) return rejectFile(upload, 'file missing after completion');
      if (stored.sizeBytes !== upload.sizeBytes) {
        return rejectFile(
          upload,
          `size mismatch: declared ${upload.sizeBytes} bytes, stored ${stored.sizeBytes}`,
        );
      }
      const head = await storage.readRange(
        upload.key,
        0,
        Math.min(SIGNATURE_BYTES, upload.sizeBytes) - 1,
      );
      if (!matchesDeclaredType(head, upload.mimeType)) {
        return rejectFile(upload, `file content is not ${upload.mimeType}`);
      }

      const done = await UploadModel.findOneAndUpdate(
        { _id: upload._id, status: 'COMPLETING' },
        { $set: { status: 'COMPLETED', completedAt: new Date() } },
        { returnDocument: 'after' },
      ).lean<LeanUpload>();
      await changeProcessing(videoId, 'VERIFYING');
      // Queue processing. If Redis is briefly unavailable the upload still
      // succeeds: the recovery sweep queues VERIFYING videos without a job.
      try {
        await deps.onVerified?.({ id: videoId, storageKey: upload.key, mimeType: upload.mimeType });
      } catch (err) {
        logger.warn({ err, videoId }, 'could not queue processing; recovery will retry');
      }
      return toUploadDto(done ?? upload);
    },

    /** Cancels an upload in progress. The video's lifecycle ends (ABORTED). */
    async abort(videoId: string): Promise<UploadDto> {
      const upload = await UploadModel.findOneAndUpdate(
        { videoId, status: 'ACTIVE' },
        { $set: { status: 'ABORTED', failureReason: 'cancelled by an administrator' } },
        { returnDocument: 'after' },
      ).lean<LeanUpload>();
      if (!upload) return explainNotActive(videoId);
      await storage.abortMultipartUpload(upload.key, upload.storageUploadId);
      await changeProcessing(videoId, 'ABORTED', { failureReason: 'upload cancelled' });
      return toUploadDto(upload);
    },

    /**
     * Ends uploads past their deadline: aborts the multipart upload (storage
     * drops the parts), deletes a file that may have been completed, and
     * moves the video to ABORTED. Safe to run from several instances at once:
     * each upload is claimed atomically. The bucket's lifecycle rule
     * (AbortIncompleteMultipartUpload) is the safety net if this never runs.
     */
    async expireStale(now = new Date()): Promise<number> {
      let expired = 0;
      for (;;) {
        const upload = await UploadModel.findOneAndUpdate(
          {
            status: mongoose.trusted({ $in: ['ACTIVE', 'COMPLETING'] }),
            expiresAt: mongoose.trusted({ $lte: now }),
          },
          { $set: { status: 'EXPIRED', failureReason: 'upload expired' } },
          { returnDocument: 'after' },
        ).lean<LeanUpload>();
        if (!upload) break;
        expired += 1;
        try {
          await storage.abortMultipartUpload(upload.key, upload.storageUploadId);
          await storage.delete(upload.key);
        } catch (err) {
          // The lifecycle rule cleans up whatever this could not.
          logger.warn({ err, uploadId: upload._id.toString() }, 'upload.expire_storage_failed');
        }
        try {
          await changeProcessing(upload.videoId.toString(), 'ABORTED', {
            failureReason: 'upload expired',
          });
        } catch (err) {
          // Deleted video or already moved on: nothing to change.
          if (!(err instanceof AppError)) throw err;
        }
        await auditSystem({
          action: 'video.upload_expired',
          targetType: 'video',
          targetId: upload.videoId,
        });
      }
      if (expired) logger.info({ event: 'upload.expired', count: expired }, 'expired uploads');
      return expired;
    },
  };
}
