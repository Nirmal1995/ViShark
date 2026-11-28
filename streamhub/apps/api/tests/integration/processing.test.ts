import { PutObjectCommand } from '@aws-sdk/client-s3';
import { QUEUE_NAMES, type TranscodeResult } from '@streamhub/contracts';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createS3Client } from '../../src/infrastructure/storage.ts';
import { AuditLogModel } from '../../src/modules/audit/audit.model.ts';
import {
  createProcessingService,
  type ProcessingService,
} from '../../src/modules/processing/processing.service.ts';
import { VideoModel } from '../../src/modules/videos/video.model.ts';
import { silentLogger } from '../helpers.ts';
import {
  ORIGIN,
  buildAuthApp,
  connectTestInfra,
  createUser,
  disconnectTestInfra,
  login,
  resetTestData,
  testConfig,
} from './setup.ts';

/**
 * The API's half of processing: queueing after an upload, recording the
 * worker's results, HLS playlists with signed segment URLs, and recovery
 * from lost messages. The worker itself is tested in apps/worker.
 */
const config = testConfig({ UPLOAD_PART_SIZE_BYTES: String(5 * 1024 * 1024) });
const s3 = createS3Client(config);
const MEDIA = config.S3_BUCKET_MEDIA ?? 'streamhub-media';

let redis: Redis;
let connection: Redis;
let processing: ProcessingService;
let app: ReturnType<typeof buildAuthApp>;
type Session = Awaited<ReturnType<typeof login>>;
let admin: Session;
let viewer: Session;

beforeAll(async () => {
  redis = await connectTestInfra(config);
  connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
});
beforeEach(async () => {
  await resetTestData();
  await processing?.close();
  processing = createProcessingService({ connection, config, logger: silentLogger });
  await processing.queue.obliterate({ force: true });
  app = buildAuthApp({ redis, config, processing });
  await createUser({ email: 'admin@example.com', role: 'ADMIN' });
  await createUser({ email: 'viewer@example.com' });
  admin = await login(app, 'admin@example.com');
  viewer = await login(app, 'viewer@example.com');
});
afterAll(async () => {
  await processing?.close();
  connection.disconnect();
  await disconnectTestInfra();
});

const api = (s: Session) => ({
  get: (path: string) => s.agent.get(`/api/v1${path}`),
  post: (path: string, body: object = {}) =>
    s.agent
      .post(`/api/v1${path}`)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', s.csrfToken)
      .send(body),
});

/** Draft video with a verified upload (VERIFYING), through the real API. */
async function uploadedVideo() {
  const id = (await api(admin).post('/videos', { title: 'Glendalough in the rain' })).body.data
    .id as string;
  const file = Buffer.alloc(2048, 7);
  Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]).copy(file);
  const started = await api(admin).post(`/admin/videos/${id}/upload`, {
    sizeBytes: file.length,
    mimeType: 'video/mp4',
  });
  const put = await fetch(started.body.data.parts[0].url, { method: 'PUT', body: file });
  const done = await api(admin).post(`/admin/videos/${id}/upload/complete`, {
    parts: [{ partNumber: 1, etag: put.headers.get('etag') }],
  });
  expect(done.status).toBe(200);
  return id;
}

/** What the worker reports for a 720p source. */
function readyResult(videoId: string): TranscodeResult {
  const hlsPrefix = `videos/${videoId}/hls/0b5f6c2e-8a5d-4c3e-9f1a-2b3c4d5e6f70`;
  return {
    type: 'ready',
    videoId,
    durationSeconds: 12.04,
    width: 1280,
    height: 720,
    hlsPrefix,
    masterKey: `${hlsPrefix}/master.m3u8`,
    posterKey: `${hlsPrefix}/poster.jpg`,
    renditions: [
      { name: '720p', width: 1280, height: 720, bandwidth: 2_928_000 },
      { name: '360p', width: 640, height: 360, bandwidth: 928_000 },
    ],
  };
}

/** Puts a media playlist and its segments where the worker would. */
async function writeHlsOutput(result: Extract<TranscodeResult, { type: 'ready' }>) {
  const put = (Key: string, Body: string | Buffer, ContentType: string) =>
    s3.send(new PutObjectCommand({ Bucket: MEDIA, Key, Body, ContentType }));
  for (const r of result.renditions) {
    await put(
      `${result.hlsPrefix}/${r.name}/index.m3u8`,
      [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:6',
        '#EXT-X-PLAYLIST-TYPE:VOD',
        '#EXTINF:6.000000,',
        'seg_00000.ts',
        '#EXTINF:6.040000,',
        'seg_00001.ts',
        '#EXT-X-ENDLIST',
        '',
      ].join('\n'),
      'application/vnd.apple.mpegurl',
    );
    await put(
      `${result.hlsPrefix}/${r.name}/seg_00000.ts`,
      Buffer.from(`${r.name}-0`),
      'video/mp2t',
    );
    await put(
      `${result.hlsPrefix}/${r.name}/seg_00001.ts`,
      Buffer.from(`${r.name}-1`),
      'video/mp2t',
    );
  }
  await put(result.posterKey, Buffer.from('jpeg'), 'image/jpeg');
}

describe('queueing', () => {
  it('a verified upload queues exactly one transcode job for the video', async () => {
    const id = await uploadedVideo();
    const job = await processing.queue.getJob(id);
    const video = await VideoModel.findById(id).lean();
    expect(job?.data).toEqual({ videoId: id, sourceKey: video!.storageKey, mimeType: 'video/mp4' });
    expect(job?.opts.attempts).toBe(config.TRANSCODE_ATTEMPTS);

    // Queueing again (recovery, retries) cannot create a second job.
    await processing.enqueue({ id, storageKey: video!.storageKey!, mimeType: 'video/mp4' });
    expect(await processing.queue.getJobCountByTypes('waiting', 'prioritized')).toBe(1);
  });
});

describe('results', () => {
  it('started, then ready: the video becomes READY with its renditions', async () => {
    const id = await uploadedVideo();
    await processing.handleResult({ type: 'started', videoId: id });
    expect((await VideoModel.findById(id).lean())?.processingStatus).toBe('PROCESSING');

    const result = readyResult(id);
    await processing.handleResult(result);
    const video = await VideoModel.findById(id).lean();
    expect(video).toMatchObject({
      processingStatus: 'READY',
      durationSeconds: 12.04,
      width: 1280,
      height: 720,
      hlsMasterKey: `${(result as { hlsPrefix: string }).hlsPrefix}/master.m3u8`,
      thumbnailKey: `${(result as { hlsPrefix: string }).hlsPrefix}/poster.jpg`,
    });
    expect(video?.renditions.map((r) => r.name)).toEqual(['720p', '360p']);

    // A duplicate message changes nothing and is not an error.
    await processing.handleResult(result);
    const audits = await AuditLogModel.find({
      targetId: id,
      action: 'video.processing_ready',
    }).lean();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ via: 'system' });
  });

  it('failed: the video becomes FAILED with the reason', async () => {
    const id = await uploadedVideo();
    await processing.handleResult({ type: 'started', videoId: id });
    await processing.handleResult({ type: 'failed', videoId: id, reason: 'no video stream' });
    expect(await VideoModel.findById(id).lean()).toMatchObject({
      processingStatus: 'FAILED',
      failureReason: 'no video stream',
    });
    expect(
      await AuditLogModel.exists({ targetId: id, action: 'video.processing_failed' }),
    ).toBeTruthy();
  });

  it('rejects malformed messages', async () => {
    await expect(processing.handleResult({ type: 'ready', videoId: 'x' })).rejects.toThrow();
    await expect(processing.handleResult({ type: 'deleted' })).rejects.toThrow();
  });

  it('the results consumer records messages from the queue', async () => {
    const id = await uploadedVideo();
    processing.startResultsConsumer();
    const results = new Queue(QUEUE_NAMES.results, { connection });
    await results.add('started', { type: 'started', videoId: id });
    await results.add('ready', readyResult(id));
    for (let i = 0; i < 50; i++) {
      if ((await VideoModel.findById(id).lean())?.processingStatus === 'READY') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect((await VideoModel.findById(id).lean())?.processingStatus).toBe('READY');
    await results.obliterate({ force: true });
    await results.close();
  });
});

describe('HLS playback', () => {
  async function readyPublishedVideo() {
    const id = await uploadedVideo();
    const result = readyResult(id) as Extract<TranscodeResult, { type: 'ready' }>;
    await processing.handleResult({ type: 'started', videoId: id });
    await processing.handleResult(result);
    await writeHlsOutput(result);
    expect((await api(admin).post(`/videos/${id}/publish`)).status).toBe(200);
    return { id, result };
  }

  it('playback points at the master playlist and includes a signed poster', async () => {
    const { id } = await readyPublishedVideo();
    const res = await api(viewer).get(`/videos/${id}/playback`);
    expect(res.body.data).toMatchObject({
      kind: 'hls',
      mimeType: 'application/vnd.apple.mpegurl',
      url: `/api/v1/videos/${id}/hls/master.m3u8`,
      durationSeconds: 12.04,
      preview: false,
    });
    expect((await fetch(res.body.data.posterUrl)).status).toBe(200);
  });

  it('serves the master and media playlists; segments are signed storage URLs', async () => {
    const { id } = await readyPublishedVideo();
    const master = await api(viewer).get(`/videos/${id}/hls/master.m3u8`);
    expect(master.status).toBe(200);
    expect(master.headers['content-type']).toMatch(/application\/vnd\.apple\.mpegurl/);
    expect(master.headers['cache-control']).toBe('private, no-store');
    expect(master.text.split('\n')).toEqual([
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-INDEPENDENT-SEGMENTS',
      '#EXT-X-STREAM-INF:BANDWIDTH=2928000,RESOLUTION=1280x720',
      '720p/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=928000,RESOLUTION=640x360',
      '360p/index.m3u8',
      '',
    ]);

    const media = await api(viewer).get(`/videos/${id}/hls/360p/index.m3u8`);
    expect(media.status).toBe(200);
    const segments = media.text.split('\n').filter((l: string) => l && !l.startsWith('#'));
    expect(segments).toHaveLength(2);
    expect(media.text).toContain('#EXT-X-ENDLIST');
    const first = await fetch(segments[0]!);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe('360p-0');
  });

  it('only renditions the worker reported, and only for people who may watch', async () => {
    const { id } = await readyPublishedVideo();
    expect((await api(viewer).get(`/videos/${id}/hls/1080p/index.m3u8`)).status).toBe(404);
    // Anything that is not a rendition name never reaches storage.
    expect((await api(viewer).get(`/videos/${id}/hls/..%2F..%2Fsource/index.m3u8`)).status).toBe(
      400,
    );
    expect((await api(viewer).get(`/videos/${id}/hls/720/index.m3u8`)).status).toBe(400);
    expect((await request(app).get(`/api/v1/videos/${id}/hls/master.m3u8`)).status).toBe(401);

    await api(admin).post(`/videos/${id}/unpublish`);
    expect((await api(viewer).get(`/videos/${id}/hls/master.m3u8`)).status).toBe(404);
    // Administrators can still preview the processed video.
    expect((await api(admin).get(`/videos/${id}/hls/master.m3u8`)).status).toBe(200);
  });

  it('before processing finishes, administrators preview the source file', async () => {
    const id = await uploadedVideo();
    const res = await api(admin).get(`/videos/${id}/playback`);
    expect(res.body.data).toMatchObject({ kind: 'source', preview: true, posterUrl: null });
    expect((await api(admin).get(`/videos/${id}/hls/master.m3u8`)).status).toBe(404);
  });
});

describe('recovery', () => {
  /** Moves updatedAt into the past, bypassing Mongoose timestamps. */
  const age = (id: string, minutes: number) =>
    VideoModel.collection.updateOne(
      { _id: new VideoModel.base.Types.ObjectId(id) },
      { $set: { updatedAt: new Date(Date.now() - minutes * 60_000) } },
    );

  it('re-queues verified videos without a job and fails abandoned processing', async () => {
    const lost = await uploadedVideo(); // its job will vanish
    const waiting = await uploadedVideo(); // its job is still queued
    const dead = await uploadedVideo(); // processing died without a report
    await processing.handleResult({ type: 'started', videoId: dead });

    await (await processing.queue.getJob(lost))!.remove();
    await (await processing.queue.getJob(dead))!.remove();
    await age(lost, 20);
    await age(waiting, 20);
    await age(dead, config.TRANSCODE_STUCK_MINUTES + 1);

    expect(await processing.recoverStuck()).toEqual({ requeued: 1, failed: 1 });
    expect(await processing.queue.getJob(lost)).toBeTruthy();
    expect((await VideoModel.findById(waiting).lean())?.processingStatus).toBe('VERIFYING');
    expect(await VideoModel.findById(dead).lean()).toMatchObject({
      processingStatus: 'FAILED',
      failureReason: 'processing did not finish; upload the video again',
    });

    // Fresh videos are left alone.
    const fresh = await uploadedVideo();
    await (await processing.queue.getJob(fresh))!.remove();
    expect(await processing.recoverStuck()).toEqual({ requeued: 0, failed: 0 });
  });
});
