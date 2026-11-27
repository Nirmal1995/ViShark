import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../../src/modules/audit/audit.model.ts';
import { UploadModel } from '../../src/modules/uploads/upload.model.ts';
import {
  createUploadsService,
  type UploadsService,
} from '../../src/modules/uploads/uploads.service.ts';
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
  testStorage,
} from './setup.ts';

/**
 * Real multipart uploads against the local S3-compatible storage: the test
 * plays the browser, PUTting parts to the pre-signed URLs the API returns.
 */

const MiB = 1024 * 1024;
const PART = 5 * MiB; // the smallest part size S3 allows
const config = testConfig({ UPLOAD_PART_SIZE_BYTES: String(PART) });
const storage = testStorage(config);

let redis: Redis;
let app: ReturnType<typeof buildAuthApp>;
let uploads: UploadsService;
type Session = Awaited<ReturnType<typeof login>>;
let admin: Session;
let viewer: Session;

beforeAll(async () => {
  redis = await connectTestInfra(config);
});
beforeEach(async () => {
  await resetTestData();
  uploads = createUploadsService({ storage, config, logger: silentLogger });
  app = buildAuthApp({ redis, config, uploads });
  await createUser({ email: 'admin@example.com', role: 'ADMIN' });
  await createUser({ email: 'viewer@example.com' });
  admin = await login(app, 'admin@example.com');
  viewer = await login(app, 'viewer@example.com');
});
afterAll(disconnectTestInfra);

const api = (s: Session) => ({
  get: (path: string) => s.agent.get(`/api/v1${path}`),
  post: (path: string, body: object = {}) =>
    s.agent
      .post(`/api/v1${path}`)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', s.csrfToken)
      .send(body),
});

/** A file that starts like an MP4 (an ftyp box), padded to `size` bytes. */
function mp4File(size: number): Buffer {
  const file = Buffer.alloc(size, 7);
  Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]).copy(file);
  return file;
}

async function newVideo() {
  const res = await api(admin).post('/videos', { title: 'Sunrise over Howth' });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

type Part = { partNumber: number; url: string };

async function start(videoId: string, sizeBytes: number, mimeType = 'video/mp4') {
  return api(admin).post(`/admin/videos/${videoId}/upload`, { sizeBytes, mimeType });
}

/** What the browser does: PUT each slice to its URL and keep the ETag. */
async function putParts(file: Buffer, parts: Part[], partSize = PART) {
  const done: { partNumber: number; etag: string }[] = [];
  for (const part of parts) {
    const slice = file.subarray((part.partNumber - 1) * partSize, part.partNumber * partSize);
    const res = await fetch(part.url, { method: 'PUT', body: slice });
    expect(res.status, await res.clone().text()).toBe(200);
    done.push({ partNumber: part.partNumber, etag: res.headers.get('etag') ?? '' });
  }
  return done;
}

async function auditActions(videoId: string) {
  const logs = await AuditLogModel.find({ targetId: videoId }).sort({ createdAt: 1 }).lean();
  return logs.map((l) => l.action);
}

describe('upload: happy path', () => {
  it('uploads a file in parts straight to storage and moves the video to VERIFYING', async () => {
    const videoId = await newVideo();
    const file = mp4File(PART + 1024);

    const started = await start(videoId, file.length);
    expect(started.status).toBe(201);
    const session = started.body.data;
    expect(session).toMatchObject({
      videoId,
      status: 'ACTIVE',
      sizeBytes: file.length,
      partSizeBytes: PART,
      partCount: 2,
    });
    expect(session.parts).toHaveLength(2);
    // Internal storage details never leave the API.
    expect(JSON.stringify(session)).not.toMatch(/storageUploadId|"key"/);
    expect((await VideoModel.findById(videoId).lean())?.processingStatus).toBe('UPLOADING');

    const parts = await putParts(file, session.parts);
    const completed = await api(admin).post(`/admin/videos/${videoId}/upload/complete`, { parts });
    expect(completed.status).toBe(200);
    expect(completed.body.data.status).toBe('COMPLETED');

    const video = await VideoModel.findById(videoId).lean();
    expect(video).toMatchObject({
      processingStatus: 'VERIFYING',
      sizeBytes: file.length,
      mimeType: 'video/mp4',
    });
    expect(video?.storageKey).toMatch(new RegExp(`^videos/${videoId}/source/[0-9a-f-]{36}$`));
    expect(await storage.head(video!.storageKey!)).toMatchObject({ sizeBytes: file.length });
    expect(await auditActions(videoId)).toEqual([
      'video.created',
      'video.upload_started',
      'video.upload_completed',
    ]);

    const status = await api(admin).get(`/admin/videos/${videoId}/upload`);
    expect(status.body.data.status).toBe('COMPLETED');
  });

  it('accepts ETags without quotes and parts in any order', async () => {
    const videoId = await newVideo();
    const file = mp4File(PART + 10);
    const session = (await start(videoId, file.length)).body.data;
    const parts = (await putParts(file, session.parts))
      .map((p) => ({ ...p, etag: p.etag.replace(/"/g, '') }))
      .reverse();
    const res = await api(admin).post(`/admin/videos/${videoId}/upload/complete`, { parts });
    expect(res.status).toBe(200);
  });

  it('signs fresh URLs for chosen parts while the upload is active', async () => {
    const videoId = await newVideo();
    await start(videoId, PART * 3);
    const res = await api(admin).post(`/admin/videos/${videoId}/upload/part-urls`, {
      partNumbers: [2, 3],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.parts.map((p: Part) => p.partNumber)).toEqual([2, 3]);

    const outOfRange = await api(admin).post(`/admin/videos/${videoId}/upload/part-urls`, {
      partNumbers: [4],
    });
    expect(outOfRange.status).toBe(400);
  });
});

describe('upload: rules', () => {
  it('only administrators can upload', async () => {
    const videoId = await newVideo();
    const res = await api(viewer).post(`/admin/videos/${videoId}/upload`, {
      sizeBytes: 1000,
      mimeType: 'video/mp4',
    });
    expect(res.status).toBe(403);
  });

  it('rejects unsupported types, sizes over the limit and a second start', async () => {
    const videoId = await newVideo();
    expect((await start(videoId, 1000, 'application/pdf')).status).toBe(400);

    const small = buildAuthApp({
      redis,
      config: testConfig({ UPLOAD_MAX_BYTES: String(10 * MiB) }),
      uploads: createUploadsService({
        storage,
        config: { ...config, UPLOAD_MAX_BYTES: 10 * MiB },
        logger: silentLogger,
      }),
    });
    const smallAdmin = await login(small, 'admin@example.com');
    const tooBig = await smallAdmin.agent
      .post(`/api/v1/admin/videos/${videoId}/upload`)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', smallAdmin.csrfToken)
      .send({ sizeBytes: 10 * MiB + 1, mimeType: 'video/mp4' });
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.error.code).toBe('UPLOAD_TOO_LARGE');

    expect((await start(videoId, 1000)).status).toBe(201);
    const again = await start(videoId, 1000);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('a missing part or a wrong ETag is rejected and the upload stays usable', async () => {
    const videoId = await newVideo();
    const file = mp4File(PART + 100);
    const session = (await start(videoId, file.length)).body.data;
    const parts = await putParts(file, session.parts);

    const missing = await api(admin).post(`/admin/videos/${videoId}/upload/complete`, {
      parts: parts.slice(0, 1),
    });
    expect(missing.status).toBe(400);

    const wrongEtag = await api(admin).post(`/admin/videos/${videoId}/upload/complete`, {
      parts: [parts[0], { partNumber: 2, etag: '"00000000000000000000000000000000"' }],
    });
    expect(wrongEtag.status).toBe(400);
    expect(wrongEtag.body.error.code).toBe('UPLOAD_PARTS_REJECTED');
    expect((await UploadModel.findOne({ videoId }).lean())?.status).toBe('ACTIVE');

    const fixed = await api(admin).post(`/admin/videos/${videoId}/upload/complete`, { parts });
    expect(fixed.status).toBe(200);
  });

  it('a file that is not the declared type is deleted and the video fails', async () => {
    const videoId = await newVideo();
    const file = Buffer.alloc(PART + 50, 0x41); // no MP4 signature
    const session = (await start(videoId, file.length)).body.data;
    const parts = await putParts(file, session.parts);

    const res = await api(admin).post(`/admin/videos/${videoId}/upload/complete`, { parts });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('UPLOAD_VERIFICATION_FAILED');

    const video = await VideoModel.findById(videoId).lean();
    expect(video?.processingStatus).toBe('FAILED');
    expect(video?.failureReason).toMatch(/not video\/mp4/);
    expect(await storage.head(video!.storageKey!)).toBeNull();
    expect((await UploadModel.findOne({ videoId }).lean())?.status).toBe('FAILED');
    expect(await auditActions(videoId)).toContain('video.upload_rejected');
  });

  it('a file smaller than declared is rejected', async () => {
    const videoId = await newVideo();
    const declared = PART + 4096;
    const session = (await start(videoId, declared)).body.data;
    const short = mp4File(PART + 100); // last part shorter than promised
    const parts = await putParts(short, session.parts);

    const res = await api(admin).post(`/admin/videos/${videoId}/upload/complete`, { parts });
    expect(res.status).toBe(422);
    expect(res.body.error.details.reason).toMatch(/size mismatch/);
  });
});

describe('upload: abort and expiry', () => {
  it('abort ends the upload and the video', async () => {
    const videoId = await newVideo();
    const file = mp4File(PART + 1);
    const session = (await start(videoId, file.length)).body.data;

    const res = await api(admin).post(`/admin/videos/${videoId}/upload/abort`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ABORTED');
    expect((await VideoModel.findById(videoId).lean())?.processingStatus).toBe('ABORTED');

    // Storage dropped the multipart upload: its URLs no longer accept parts
    // (S3 and MinIO answer 404 NoSuchUpload; some emulators answer 500).
    const put = await fetch(session.parts[0].url, { method: 'PUT', body: file.subarray(0, 10) });
    expect(put.ok).toBe(false);

    const complete = await api(admin).post(`/admin/videos/${videoId}/upload/complete`, {
      parts: [{ partNumber: 1, etag: 'x' }],
    });
    expect(complete.status).toBe(409);
    expect(complete.body.error.code).toBe('UPLOAD_NOT_ACTIVE');
    expect(await auditActions(videoId)).toContain('video.upload_aborted');
  });

  it('an upload past its deadline cannot be completed', async () => {
    const videoId = await newVideo();
    await start(videoId, 1000);
    await UploadModel.updateOne({ videoId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await api(admin).post(`/admin/videos/${videoId}/upload/complete`, {
      parts: [{ partNumber: 1, etag: 'x' }],
    });
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('UPLOAD_EXPIRED');
  });

  it('the sweep expires abandoned uploads and is safe to run twice', async () => {
    const stale = await newVideo();
    const fresh = await newVideo();
    await start(stale, 1000);
    await start(fresh, 1000);
    await UploadModel.updateOne(
      { videoId: stale },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    expect(await uploads.expireStale()).toBe(1);
    expect(await uploads.expireStale()).toBe(0);

    expect((await UploadModel.findOne({ videoId: stale }).lean())?.status).toBe('EXPIRED');
    expect((await VideoModel.findById(stale).lean())?.processingStatus).toBe('ABORTED');
    expect((await UploadModel.findOne({ videoId: fresh }).lean())?.status).toBe('ACTIVE');
    const log = await AuditLogModel.findOne({ action: 'video.upload_expired' }).lean();
    expect(log).toMatchObject({ via: 'system', actorId: null });
  });
});
