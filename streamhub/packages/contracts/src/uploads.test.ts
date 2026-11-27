import { describe, expect, it } from 'vitest';
import {
  completeUploadBodySchema,
  MAX_PART_URLS_PER_REQUEST,
  startUploadBodySchema,
  uploadPartUrlsBodySchema,
} from './uploads.ts';

describe('upload request schemas', () => {
  it('start: exact size and a supported video type, nothing else', () => {
    expect(
      startUploadBodySchema.safeParse({ sizeBytes: 1000, mimeType: 'video/mp4' }).success,
    ).toBe(true);
    expect(startUploadBodySchema.safeParse({ sizeBytes: 0, mimeType: 'video/mp4' }).success).toBe(
      false,
    );
    expect(startUploadBodySchema.safeParse({ sizeBytes: 1.5, mimeType: 'video/mp4' }).success).toBe(
      false,
    );
    expect(startUploadBodySchema.safeParse({ sizeBytes: 10, mimeType: 'image/png' }).success).toBe(
      false,
    );
    // No client-chosen key or bucket (mass assignment).
    expect(
      startUploadBodySchema.safeParse({ sizeBytes: 10, mimeType: 'video/mp4', key: 'x' }).success,
    ).toBe(false);
  });

  it('part URLs: unique part numbers, bounded per request', () => {
    expect(uploadPartUrlsBodySchema.safeParse({ partNumbers: [1, 2] }).success).toBe(true);
    expect(uploadPartUrlsBodySchema.safeParse({ partNumbers: [1, 1] }).success).toBe(false);
    expect(uploadPartUrlsBodySchema.safeParse({ partNumbers: [0] }).success).toBe(false);
    const tooMany = Array.from({ length: MAX_PART_URLS_PER_REQUEST + 1 }, (_, i) => i + 1);
    expect(uploadPartUrlsBodySchema.safeParse({ partNumbers: tooMany }).success).toBe(false);
  });

  it('complete: part numbers within S3 limits and non-empty ETags', () => {
    expect(
      completeUploadBodySchema.safeParse({ parts: [{ partNumber: 1, etag: '"abc"' }] }).success,
    ).toBe(true);
    expect(completeUploadBodySchema.safeParse({ parts: [] }).success).toBe(false);
    expect(
      completeUploadBodySchema.safeParse({ parts: [{ partNumber: 10_001, etag: 'a' }] }).success,
    ).toBe(false);
    expect(
      completeUploadBodySchema.safeParse({ parts: [{ partNumber: 1, etag: ' ' }] }).success,
    ).toBe(false);
  });
});
