import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { TranscodeResult } from '@streamhub/contracts';
import { UnrecoverableError, type Job } from 'bullmq';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import { createProcessor } from '../../src/processor.ts';
import { run } from '../../src/process.ts';
import { createS3Client } from '../../src/storage.ts';

/**
 * The whole worker path against real FFmpeg and the local S3-compatible
 * storage: sample videos are generated with FFmpeg's test sources, uploaded
 * as "sources", processed, and the HLS output is checked in the media bucket.
 */
const envFile = fileURLToPath(new URL('../../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
const config = loadConfig({
  ...process.env,
  REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  FFMPEG_PRESET: 'ultrafast',
});
const s3: S3Client = createS3Client(config);
const silent = pino({ level: 'silent' });

let samples: string;
beforeAll(async () => {
  samples = await mkdtemp(join(tmpdir(), 'worker-samples-'));
});
afterAll(async () => {
  await rm(samples, { recursive: true, force: true });
});

let counter = 0;
const objectId = () =>
  `${'a'.repeat(16)}${(Date.now() % 1e8).toString(16).padStart(7, '0')}${counter++}`.slice(0, 24);

/** Generates a test clip with FFmpeg (colour bars plus an optional tone). */
async function makeClip(
  name: string,
  width: number,
  height: number,
  seconds: number,
  audio: boolean,
) {
  const file = join(samples, name);
  await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=${width}x${height}:rate=25:duration=${seconds}`,
      ...(audio ? ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`] : []),
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      ...(audio ? ['-c:a', 'aac', '-shortest'] : []),
      file,
    ],
    120,
  );
  return file;
}

/** Puts a file where the API would have uploaded it and returns a job for it. */
async function sourceJob(file: string, attempts = 3) {
  const videoId = objectId();
  const sourceKey = `videos/${videoId}/source/${crypto.randomUUID()}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: config.S3_BUCKET_UPLOADS,
      Key: sourceKey,
      Body: await readFile(file),
    }),
  );
  const job = {
    id: videoId,
    data: { videoId, sourceKey, mimeType: 'video/mp4' },
    attemptsMade: 0,
    opts: { attempts },
  } as unknown as Job;
  return { videoId, job };
}

function processorWithReports() {
  const reports: TranscodeResult[] = [];
  const processJob = createProcessor({
    s3,
    config,
    logger: silent,
    report: (r) => {
      reports.push(r);
      return Promise.resolve();
    },
  });
  return { processJob, reports };
}

async function mediaKeys(prefix: string) {
  const list = await s3.send(
    new ListObjectsV2Command({ Bucket: config.S3_BUCKET_MEDIA, Prefix: prefix }),
  );
  return (list.Contents ?? []).map((o) => o.Key!.slice(prefix.length + 1)).sort();
}

async function mediaText(key: string) {
  const res = await s3.send(new GetObjectCommand({ Bucket: config.S3_BUCKET_MEDIA, Key: key }));
  return res.Body!.transformToString();
}

describe('worker processor', () => {
  it('turns a 720p clip into 720p, 480p and 360p HLS with a poster, nothing above the source', async () => {
    const clip = await makeClip('hd.mp4', 1280, 720, 4, true);
    const { videoId, job } = await sourceJob(clip);
    const { processJob, reports } = processorWithReports();

    await processJob(job);

    expect(reports[0]).toEqual({ type: 'started', videoId });
    const ready = reports[1];
    expect(ready).toMatchObject({ type: 'ready', videoId, width: 1280, height: 720 });
    if (ready?.type !== 'ready') throw new Error('not ready');
    expect(ready.durationSeconds).toBeGreaterThan(3.5);
    expect(ready.renditions.map((r) => r.name)).toEqual(['720p', '480p', '360p']);

    const files = await mediaKeys(ready.hlsPrefix);
    expect(files).toContain('master.m3u8');
    expect(files).toContain('poster.jpg');
    for (const name of ['720p', '480p', '360p']) {
      expect(files).toContain(`${name}/index.m3u8`);
      expect(files.some((f) => f.startsWith(`${name}/seg_`) && f.endsWith('.ts'))).toBe(true);
    }
    expect(files.some((f) => f.startsWith('1080p/'))).toBe(false);

    const master = await mediaText(ready.masterKey);
    expect(master).toContain('RESOLUTION=1280x720');
    expect(master).not.toContain('1920x1080');
    const media = await mediaText(`${ready.hlsPrefix}/360p/index.m3u8`);
    expect(media).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(media).toContain('#EXT-X-ENDLIST');

    // The 360p output really is 640x360.
    const local = join(samples, 'seg.ts');
    const segment = files.find((f) => f.startsWith('360p/seg_'))!;
    await writeFile(
      local,
      Buffer.from(
        await (
          await s3.send(
            new GetObjectCommand({
              Bucket: config.S3_BUCKET_MEDIA,
              Key: `${ready.hlsPrefix}/${segment}`,
            }),
          )
        ).Body!.transformToByteArray(),
      ),
    );
    const { stdout } = await run(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height',
        '-of',
        'csv=p=0',
        local,
      ],
      30,
    );
    expect(stdout.trim().split('\n')[0]).toBe('640,360');
  });

  it('keeps a small portrait clip at its own size (no upscaling) and handles no audio', async () => {
    const clip = await makeClip('portrait.mp4', 240, 426, 2, false);
    const { job } = await sourceJob(clip);
    const { processJob, reports } = processorWithReports();
    await processJob(job);
    const ready = reports.find((r) => r.type === 'ready');
    if (ready?.type !== 'ready') throw new Error('not ready');
    expect(ready.renditions).toEqual([
      { name: '240p', width: 240, height: 426, bandwidth: 600_000 },
    ]);
  });

  it('fails a corrupt file at once, without retries, and reports why', async () => {
    const junk = join(samples, 'junk.mp4');
    await writeFile(junk, Buffer.alloc(50_000, 0x41));
    const { videoId, job } = await sourceJob(junk);
    const { processJob, reports } = processorWithReports();

    await expect(processJob(job)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(reports).toEqual([
      { type: 'started', videoId },
      { type: 'failed', videoId, reason: expect.stringMatching(/^not a readable video/) },
    ]);
    // Nothing left behind in the media bucket for this video.
    expect(await mediaKeys(`videos/${videoId}`)).toEqual([]);
  });

  it('retries transient errors and only reports failure on the last attempt', async () => {
    const { videoId, job } = await sourceJob(await makeClip('t.mp4', 320, 180, 1, false), 2);
    // A source that vanished: a storage error, not a media problem.
    (job.data as { sourceKey: string }).sourceKey =
      `videos/${videoId}/source/${crypto.randomUUID()}`;
    const { processJob, reports } = processorWithReports();

    await expect(processJob(job)).rejects.not.toBeInstanceOf(UnrecoverableError);
    expect(reports.map((r) => r.type)).toEqual(['started']);

    (job as { attemptsMade: number }).attemptsMade = 1; // the final attempt
    await expect(processJob(job)).rejects.toThrow();
    expect(reports.map((r) => r.type)).toEqual(['started', 'started', 'failed']);
  });
});
