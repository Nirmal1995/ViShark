import { z } from 'zod';
import { objectIdSchema } from './catalog.ts';

/**
 * Upload requests (Phase 4b). The browser never sends the file to the API:
 * it asks for pre-signed part URLs, PUTs the parts straight to object
 * storage, then reports the parts' ETags so the API can finish and verify.
 */

/** Containers the transcoder will accept. Checked against the file's first bytes too. */
export const VIDEO_MIME_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'] as const;
export type VideoMimeType = (typeof VIDEO_MIME_TYPES)[number];

/** S3 limits: part numbers 1..10,000. */
export const MAX_UPLOAD_PARTS = 10_000;
/** Fresh URLs per request, so one call cannot sign thousands of URLs. */
export const MAX_PART_URLS_PER_REQUEST = 100;

const partNumberSchema = z.number().int().min(1).max(MAX_UPLOAD_PARTS);

export const startUploadBodySchema = z.strictObject({
  /** Exact file size. The API checks the stored object against it. */
  sizeBytes: z
    .number()
    .int()
    .min(1)
    .max(50 * 1024 ** 3)
    .meta({ example: 104_857_600 }),
  mimeType: z.enum(VIDEO_MIME_TYPES),
});

export const uploadPartUrlsBodySchema = z.strictObject({
  partNumbers: z
    .array(partNumberSchema)
    .min(1)
    .max(MAX_PART_URLS_PER_REQUEST)
    .refine((numbers) => new Set(numbers).size === numbers.length, 'part numbers must be unique'),
});

export const completeUploadBodySchema = z.strictObject({
  parts: z
    .array(
      z.strictObject({
        partNumber: partNumberSchema,
        /** The ETag response header storage returned for this part's PUT. */
        etag: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .meta({ example: '"9b2cf535f27731c974343645a3985328"' }),
      }),
    )
    .min(1)
    .max(MAX_UPLOAD_PARTS),
});

export type StartUploadBody = z.infer<typeof startUploadBodySchema>;
export type UploadPartUrlsBody = z.infer<typeof uploadPartUrlsBodySchema>;
export type CompleteUploadBody = z.infer<typeof completeUploadBodySchema>;

// Responses

export const UPLOAD_STATUSES = [
  'ACTIVE',
  'COMPLETING',
  'COMPLETED',
  'ABORTED',
  'EXPIRED',
  'FAILED',
] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

export const partUrlDtoSchema = z.object({
  partNumber: z.number().int(),
  url: z.string().meta({ description: 'PUT the part body here. Valid until urlsExpireAt.' }),
});

export const uploadDtoSchema = z.object({
  id: objectIdSchema,
  videoId: objectIdSchema,
  status: z.enum(UPLOAD_STATUSES),
  mimeType: z.enum(VIDEO_MIME_TYPES),
  sizeBytes: z.number().int(),
  partSizeBytes: z.number().int().meta({
    description: 'Every part except the last must be exactly this size.',
  }),
  partCount: z.number().int(),
  expiresAt: z.iso.datetime().meta({
    description: 'After this the upload is abandoned and cleaned up.',
  }),
  createdAt: z.iso.datetime(),
});

export const uploadSessionDtoSchema = uploadDtoSchema.extend({
  parts: z.array(partUrlDtoSchema),
  urlsExpireAt: z.iso.datetime(),
});

export const partUrlsDtoSchema = z.object({
  parts: z.array(partUrlDtoSchema),
  urlsExpireAt: z.iso.datetime(),
});

export type UploadDto = z.infer<typeof uploadDtoSchema>;
export type UploadSessionDto = z.infer<typeof uploadSessionDtoSchema>;
export type PartUrlsDto = z.infer<typeof partUrlsDtoSchema>;
