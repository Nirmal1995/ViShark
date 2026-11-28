import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { VideoModel } from '../../src/modules/videos/video.model.ts';
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
 * Playback against real storage: the API signs a URL, storage serves the
 * bytes (including 206 range responses). Plus progress, history, favourites.
 */

const config = testConfig({ UPLOAD_PART_SIZE_BYTES: String(5 * 1024 * 1024) });
const storage = testStorage(config);
const FILE_SIZE = 4096;

let redis: Redis;
let app: ReturnType<typeof buildAuthApp>;
type Session = Awaited<ReturnType<typeof login>>;
let admin: Session;
let viewer: Session;
let other: Session;

beforeAll(async () => {
  redis = await connectTestInfra(config);
});
beforeEach(async () => {
  await resetTestData();
  app = buildAuthApp({ redis, config });
  await createUser({ email: 'admin@example.com', role: 'ADMIN' });
  await createUser({ email: 'viewer@example.com' });
  await createUser({ email: 'other@example.com' });
  admin = await login(app, 'admin@example.com');
  viewer = await login(app, 'viewer@example.com');
  other = await login(app, 'other@example.com');
});
afterAll(disconnectTestInfra);

const api = (s: Session) => ({
  get: (path: string) => s.agent.get(`/api/v1${path}`),
  send: (method: 'post' | 'put' | 'delete', path: string, body: object = {}) =>
    s.agent[method](`/api/v1${path}`)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', s.csrfToken)
      .send(body),
});

/** Bytes 0..11 are an MP4 ftyp box; the rest is a counting pattern for range checks. */
function mp4File(size = FILE_SIZE): Buffer {
  const file = Buffer.alloc(size);
  for (let i = 0; i < size; i++) file[i] = i % 251;
  Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]).copy(file);
  return file;
}

/** A video whose file is uploaded and verified (VERIFYING): what admins can preview. */
async function uploadedVideo(title = 'Cliffs of Moher at dawn') {
  const created = await api(admin).send('post', '/videos', { title });
  const id = created.body.data.id as string;
  const file = mp4File();
  const started = await api(admin).send('post', `/admin/videos/${id}/upload`, {
    sizeBytes: file.length,
    mimeType: 'video/mp4',
  });
  const [part] = started.body.data.parts;
  const put = await fetch(part.url, { method: 'PUT', body: file });
  const done = await api(admin).send('post', `/admin/videos/${id}/upload/complete`, {
    parts: [{ partNumber: 1, etag: put.headers.get('etag') }],
  });
  expect(done.status).toBe(200);
  return { id, file };
}

/** What the worker will do in Phase 6; until then tests set READY directly. */
async function readyAndPublished(durationSeconds = 200) {
  const video = await uploadedVideo();
  await VideoModel.updateOne(
    { _id: video.id },
    { $set: { processingStatus: 'READY', durationSeconds } },
  );
  const published = await api(admin).send('post', `/videos/${video.id}/publish`);
  expect(published.status).toBe(200);
  return video;
}

describe('playback', () => {
  it('needs a signed-in user', async () => {
    const { id } = await readyAndPublished();
    const res = await request(app).get(`/api/v1/videos/${id}/playback`);
    expect(res.status).toBe(401);
  });

  it('administrators preview a verified upload; storage serves byte ranges', async () => {
    const { id, file } = await uploadedVideo();
    const res = await api(admin).get(`/videos/${id}/playback`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      videoId: id,
      kind: 'source',
      mimeType: 'video/mp4',
      preview: true,
      resumePositionSeconds: 0,
    });
    const { url } = res.body.data;

    const range = await fetch(url, { headers: { Range: 'bytes=100-199' } });
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe(`bytes 100-199/${file.length}`);
    const bytes = Buffer.from(await range.arrayBuffer());
    expect(bytes.equals(file.subarray(100, 200))).toBe(true);

    const tail = await fetch(url, { headers: { Range: `bytes=${file.length - 10}-` } });
    expect(tail.status).toBe(206);
    expect(Buffer.from(await tail.arrayBuffer()).equals(file.subarray(-10))).toBe(true);

    const whole = await fetch(url);
    expect(whole.status).toBe(200);
    expect((await whole.arrayBuffer()).byteLength).toBe(file.length);
  });

  it('viewers only play published, processed videos; everything else is a 404', async () => {
    const draft = await uploadedVideo();
    expect((await api(viewer).get(`/videos/${draft.id}/playback`)).status).toBe(404);

    await VideoModel.updateOne({ _id: draft.id }, { $set: { processingStatus: 'READY' } });
    expect((await api(viewer).get(`/videos/${draft.id}/playback`)).status).toBe(404);
    expect((await api(admin).get(`/videos/${draft.id}/playback`)).body.data.preview).toBe(true);

    await api(admin).send('post', `/videos/${draft.id}/publish`);
    const res = await api(viewer).get(`/videos/${draft.id}/playback`);
    expect(res.status).toBe(200);
    expect(res.body.data.preview).toBe(false);

    await api(admin).send('delete', `/videos/${draft.id}`);
    expect((await api(viewer).get(`/videos/${draft.id}/playback`)).status).toBe(404);
    expect((await api(admin).get(`/videos/${draft.id}/playback`)).status).toBe(404);
  });

  it('a video without an uploaded file cannot be played, even by administrators', async () => {
    const created = await api(admin).send('post', '/videos', { title: 'Nothing here yet' });
    expect((await api(admin).get(`/videos/${created.body.data.id}/playback`)).status).toBe(404);
  });

  it('storage rejects tampered and expired URLs', async () => {
    const { id } = await readyAndPublished();
    const { url } = (await api(viewer).get(`/videos/${id}/playback`)).body.data;

    const tampered = new URL(url);
    const signature = tampered.searchParams.get('X-Amz-Signature')!;
    tampered.searchParams.set(
      'X-Amz-Signature',
      signature.replace(/.$/, (c) => (c === '0' ? '1' : '0')),
    );
    expect((await fetch(tampered)).status).toBe(403);

    const key = (await VideoModel.findById(id).lean())!.storageKey!;
    const shortLived = await storage.presignGet(key, 1);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect((await fetch(shortLived)).status).toBe(403);
  });
});

describe('progress and history', () => {
  it('saves the position, resumes from it, and lists the history newest first', async () => {
    const first = await readyAndPublished();
    const second = await readyAndPublished();

    expect(
      (await api(viewer).send('put', `/videos/${first.id}/progress`, { positionSeconds: 42 }))
        .status,
    ).toBe(204);
    await api(viewer).send('put', `/videos/${second.id}/progress`, { positionSeconds: 120.5 });

    const playback = await api(viewer).get(`/videos/${second.id}/playback`);
    expect(playback.body.data.resumePositionSeconds).toBe(120.5);

    const history = await api(viewer).get('/users/me/history');
    expect(history.status).toBe(200);
    expect(history.body.data.map((e: { video: { id: string } }) => e.video.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(history.body.data[0]).toMatchObject({ positionSeconds: 120.5, completed: false });
    expect(history.body.meta).toMatchObject({ page: 1, total: 2 });

    // Someone else's history is separate.
    expect((await api(other).get('/users/me/history')).body.data).toEqual([]);
  });

  it('near the end counts as finished; a finished video starts from the beginning', async () => {
    const { id } = await readyAndPublished(200);
    await api(viewer).send('put', `/videos/${id}/progress`, { positionSeconds: 9999 });
    const history = (await api(viewer).get('/users/me/history')).body.data;
    expect(history[0]).toMatchObject({ positionSeconds: 200, completed: true });
    expect((await api(viewer).get(`/videos/${id}/playback`)).body.data.resumePositionSeconds).toBe(
      0,
    );
  });

  it('rejects invalid positions and videos the user cannot watch', async () => {
    const { id } = await readyAndPublished();
    expect(
      (await api(viewer).send('put', `/videos/${id}/progress`, { positionSeconds: -1 })).status,
    ).toBe(400);
    const draft = await uploadedVideo();
    expect(
      (await api(viewer).send('put', `/videos/${draft.id}/progress`, { positionSeconds: 1 }))
        .status,
    ).toBe(404);
  });

  it('entries can be removed (idempotent) and unpublished videos drop out of the list', async () => {
    const kept = await readyAndPublished();
    const hidden = await readyAndPublished();
    await api(viewer).send('put', `/videos/${kept.id}/progress`, { positionSeconds: 5 });
    await api(viewer).send('put', `/videos/${hidden.id}/progress`, { positionSeconds: 5 });

    await api(admin).send('post', `/videos/${hidden.id}/unpublish`);
    let history = (await api(viewer).get('/users/me/history')).body;
    expect(history.data.map((e: { video: { id: string } }) => e.video.id)).toEqual([kept.id]);
    expect(history.meta.total).toBe(1);

    expect((await api(viewer).send('delete', `/users/me/history/${kept.id}`)).status).toBe(204);
    expect((await api(viewer).send('delete', `/users/me/history/${kept.id}`)).status).toBe(204);
    history = (await api(viewer).get('/users/me/history')).body;
    expect(history.data).toEqual([]);
  });
});

describe('favourites', () => {
  it('add and remove are idempotent; only watchable videos can be saved', async () => {
    const { id } = await readyAndPublished();
    expect((await api(viewer).send('put', `/videos/${id}/favourite`)).status).toBe(204);
    expect((await api(viewer).send('put', `/videos/${id}/favourite`)).status).toBe(204);

    const list = await api(viewer).get('/users/me/favourites');
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].video).toMatchObject({ id, title: 'Cliffs of Moher at dawn' });
    expect(list.body.data[0].video).not.toHaveProperty('storageKey');

    expect((await api(viewer).send('delete', `/videos/${id}/favourite`)).status).toBe(204);
    expect((await api(viewer).send('delete', `/videos/${id}/favourite`)).status).toBe(204);
    expect((await api(viewer).get('/users/me/favourites')).body.data).toEqual([]);

    const draft = await uploadedVideo();
    expect((await api(viewer).send('put', `/videos/${draft.id}/favourite`)).status).toBe(404);
  });

  it('archived videos disappear from favourites', async () => {
    const { id } = await readyAndPublished();
    await api(viewer).send('put', `/videos/${id}/favourite`);
    await api(admin).send('post', `/videos/${id}/archive`);
    expect((await api(viewer).get('/users/me/favourites')).body.data).toEqual([]);
  });
});
