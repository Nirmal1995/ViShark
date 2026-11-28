import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { WorkerConfig } from './config.ts';

/** Same client rules as the API: keys only locally, role credentials on AWS. */
export function createS3Client(config: WorkerConfig): S3Client {
  return new S3Client({
    region: config.S3_REGION,
    ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}),
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    ...(config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: config.S3_ACCESS_KEY_ID,
            secretAccessKey: config.S3_SECRET_ACCESS_KEY,
          },
        }
      : {}),
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 5,
  });
}

const CONTENT_TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.jpg': 'image/jpeg',
};

export async function download(s3: S3Client, bucket: string, key: string, file: string) {
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!result.Body) throw new Error(`empty object ${key}`);
  await pipeline(result.Body as Readable, createWriteStream(file));
}

/**
 * Uploads every file under `dir` to `prefix/<relative path>`. Returns the keys
 * written so far even on failure, so the caller can clean up a partial upload.
 */
export async function uploadDirectory(
  s3: S3Client,
  bucket: string,
  dir: string,
  prefix: string,
  written: string[],
): Promise<void> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    const key = `${prefix}/${relative(dir, file).split('\\').join('/')}`;
    const contentType = CONTENT_TYPES[extname(file)] ?? 'application/octet-stream';
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: createReadStream(file),
        ContentLength: (await stat(file)).size,
        ContentType: contentType,
        // Output never changes under a key (a re-run writes a new prefix).
        CacheControl:
          contentType === 'application/vnd.apple.mpegurl'
            ? 'no-cache'
            : 'max-age=31536000, immutable',
      }),
    );
    written.push(key);
  }
}

export async function deleteKeys(s3: S3Client, bucket: string, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
      }),
    );
  }
}
