import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../../src/modules/audit/audit.model.ts';
import { changeProcessing } from '../../src/modules/videos/videos.service.ts';
import { VideoModel } from '../../src/modules/videos/video.model.ts';
import {
  ORIGIN,
  buildAuthApp,
  connectTestInfra,
  createUser,
  disconnectTestInfra,
  login,
  resetTestData,
} from './setup.ts';

let redis: Redis;
let app: ReturnType<typeof buildAuthApp>;
type Session = Awaited<ReturnType<typeof login>>;
let admin: Session;
let viewer: Session;

beforeAll(async () => {
  redis = await connectTestInfra();
});
beforeEach(async () => {
  await resetTestData();
  app = buildAuthApp({ redis });
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
  patch: (path: string, body: object) =>
    s.agent
      .patch(`/api/v1${path}`)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', s.csrfToken)
      .send(body),
  delete: (path: string) =>
    s.agent.delete(`/api/v1${path}`).set('Origin', ORIGIN).set('X-CSRF-Token', s.csrfToken),
});

async function newCategory(name = 'Documentaries') {
  const res = await api(admin).post('/categories', { name });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

async function newVideo(body: object = {}) {
  const res = await api(admin).post('/videos', { title: 'Sunrise over Howth', ...body });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

/** Walks the processing state machine to READY, as uploads and the worker will. */
async function makeReady(id: string) {
  for (const to of ['UPLOADING', 'VERIFYING', 'PROCESSING', 'READY'] as const) {
    await changeProcessing(id, to);
  }
}

async function publishedVideo(body: object = {}) {
  const id = await newVideo(body);
  await makeReady(id);
  expect((await api(admin).post(`/videos/${id}/publish`)).status).toBe(200);
  return id;
}

describe('categories', () => {
  it('admins create, rename and delete; everyone signed in can list', async () => {
    const id = await newCategory('Science & Nature');
    const list = await api(viewer).get('/categories');
    expect(list.body.data).toEqual([
      { id, name: 'Science & Nature', slug: 'science-nature', description: '' },
    ]);
    const renamed = await api(admin).patch(`/categories/${id}`, { name: 'Nature' });
    expect(renamed.body.data.slug).toBe('nature');
    expect((await api(admin).delete(`/categories/${id}`)).status).toBe(204);
  });

  it('viewers cannot change categories', async () => {
    expect((await api(viewer).post('/categories', { name: 'Hacked' })).status).toBe(403);
    const id = await newCategory();
    expect((await api(viewer).delete(`/categories/${id}`)).status).toBe(403);
  });

  it('rejects names that collide after normalisation', async () => {
    await newCategory('Sci-Fi');
    const res = await api(admin).post('/categories', { name: '  sci fi ' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CATEGORY_EXISTS');
  });

  it('rejects a name without letters or digits', async () => {
    expect((await api(admin).post('/categories', { name: '!!!' })).status).toBe(400);
  });

  it('cannot delete a category that videos use', async () => {
    const categoryId = await newCategory();
    const videoId = await newVideo({ categoryId });
    const res = await api(admin).delete(`/categories/${categoryId}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CATEGORY_IN_USE');
    await api(admin).delete(`/videos/${videoId}`);
    expect((await api(admin).delete(`/categories/${categoryId}`)).status).toBe(204);
  });

  it('requires the CSRF token', async () => {
    const res = await admin.agent
      .post('/api/v1/categories')
      .set('Origin', ORIGIN)
      .send({ name: 'No token' });
    expect(res.status).toBe(403);
  });
});

describe('video management', () => {
  it('creates a draft that waits for its upload', async () => {
    const categoryId = await newCategory();
    const res = await api(admin).post('/videos', { title: 'Cliffs', categoryId });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      title: 'Cliffs',
      category: { id: categoryId, name: 'Documentaries', slug: 'documentaries' },
      publicationStatus: 'DRAFT',
      processingStatus: 'INITIATED',
      visibility: 'PUBLIC',
      hasFile: false,
    });
  });

  it('rejects unknown categories and fields it does not own (mass assignment)', async () => {
    const unknown = await api(admin).post('/videos', {
      title: 'x',
      categoryId: '6730c2f4a1b2c3d4e5f60718',
    });
    expect(unknown.status).toBe(400);
    for (const field of [
      { processingStatus: 'READY' },
      { ownerId: '6730c2f4a1b2c3d4e5f60718' },
      { storageKey: 'a' },
    ]) {
      expect((await api(admin).post('/videos', { title: 'x', ...field })).status).toBe(400);
    }
    const id = await newVideo();
    expect(
      (await api(admin).patch(`/videos/${id}`, { publicationStatus: 'PUBLISHED' })).status,
    ).toBe(400);
  });

  it('viewers cannot create, edit, publish or delete', async () => {
    const id = await newVideo();
    expect((await api(viewer).post('/videos', { title: 'x' })).status).toBe(403);
    expect((await api(viewer).patch(`/videos/${id}`, { title: 'x' })).status).toBe(403);
    expect((await api(viewer).post(`/videos/${id}/publish`)).status).toBe(403);
    expect((await api(viewer).delete(`/videos/${id}`)).status).toBe(403);
    expect((await api(viewer).get('/admin/videos')).status).toBe(403);
  });

  it('cannot publish before processing is READY', async () => {
    const id = await newVideo();
    const res = await api(admin).post(`/videos/${id}/publish`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'INVALID_TRANSITION',
      details: { to: 'PUBLISHED', publicationStatus: 'DRAFT', processingStatus: 'INITIATED' },
    });
  });

  it('rejects processing jumps that skip steps', async () => {
    const id = await newVideo();
    await expect(changeProcessing(id, 'READY')).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    await changeProcessing(id, 'UPLOADING');
    await changeProcessing(id, 'ABORTED');
    await expect(changeProcessing(id, 'UPLOADING')).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
  });

  it('enforces the publication state machine', async () => {
    const id = await newVideo();
    await makeReady(id);
    expect((await api(admin).post(`/videos/${id}/unpublish`)).status).toBe(409);
    expect((await api(admin).post(`/videos/${id}/restore`)).status).toBe(409);
    expect((await api(admin).post(`/videos/${id}/publish`)).body.data.publicationStatus).toBe(
      'PUBLISHED',
    );
    expect((await api(admin).post(`/videos/${id}/restore`)).status).toBe(409);
    expect((await api(admin).post(`/videos/${id}/archive`)).status).toBe(200);
    expect((await api(admin).post(`/videos/${id}/publish`)).status).toBe(409);
    expect((await api(admin).post(`/videos/${id}/restore`)).body.data.publicationStatus).toBe(
      'DRAFT',
    );
  });

  it('two concurrent publish requests: exactly one succeeds', async () => {
    const id = await newVideo();
    await makeReady(id);
    const results = await Promise.all([
      api(admin).post(`/videos/${id}/publish`),
      api(admin).post(`/videos/${id}/publish`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('soft-deletes: gone from every view at once, kept in the database', async () => {
    const id = await publishedVideo();
    expect((await api(admin).delete(`/videos/${id}`)).status).toBe(204);
    expect((await api(viewer).get(`/videos/${id}`)).status).toBe(404);
    expect((await api(admin).get(`/videos/${id}`)).status).toBe(404);
    expect((await api(viewer).get('/videos')).body.data).toEqual([]);
    expect((await api(admin).get('/admin/videos')).body.data).toEqual([]);
    expect((await api(admin).delete(`/videos/${id}`)).status).toBe(404);
    const stored = await VideoModel.findById(id).lean();
    expect(stored?.deletedAt).toBeInstanceOf(Date);
    expect(stored?.publicationStatus).toBe('DRAFT');
  });

  it('never exposes storage keys', async () => {
    const id = await newVideo();
    await changeProcessing(id, 'UPLOADING', { storageKey: 'uploads/secret-key' });
    const res = await api(admin).get(`/videos/${id}`);
    expect(JSON.stringify(res.body)).not.toContain('secret-key');
    expect(res.body.data.hasFile).toBe(true);
  });
});

describe('catalogue', () => {
  it('lists only published, ready, public videos, newest first', async () => {
    const older = await publishedVideo({ title: 'Older' });
    const newer = await publishedVideo({ title: 'Newer' });
    await newVideo({ title: 'Draft' });
    await publishedVideo({ title: 'Unlisted', visibility: 'UNLISTED' });
    const res = await api(viewer).get('/videos');
    expect(res.body.data.map((v: { id: string }) => v.id)).toEqual([newer, older]);
    expect(res.body.meta).toEqual({ page: 1, pageSize: 20, total: 2, totalPages: 1 });
    expect(Object.keys(res.body.data[0]).sort()).toEqual(
      [
        'category',
        'description',
        'durationSeconds',
        'height',
        'id',
        'publishedAt',
        'title',
        'width',
      ].sort(),
    );
  });

  it('unlisted videos are watchable by id; drafts are a plain 404 for viewers', async () => {
    const unlisted = await publishedVideo({ visibility: 'UNLISTED' });
    const draft = await newVideo();
    expect((await api(viewer).get(`/videos/${unlisted}`)).status).toBe(200);
    const res = await api(viewer).get(`/videos/${draft}`);
    expect(res.status).toBe(404);
    expect((await api(viewer).get('/videos/6730c2f4a1b2c3d4e5f60718')).body).toMatchObject({
      error: { code: res.body.error.code },
    });
    expect((await api(admin).get(`/videos/${draft}`)).status).toBe(200);
  });

  it('filters by category and searches titles', async () => {
    const nature = await newCategory('Nature');
    const match = await publishedVideo({ title: 'Puffins of Skellig', categoryId: nature });
    await publishedVideo({ title: 'City lights' });
    expect(
      (await api(viewer).get(`/videos?categoryId=${nature}`)).body.data.map(
        (v: { id: string }) => v.id,
      ),
    ).toEqual([match]);
    expect(
      (await api(viewer).get('/videos?q=puffins')).body.data.map((v: { id: string }) => v.id),
    ).toEqual([match]);
  });

  it('paginates with bounded page sizes', async () => {
    for (let i = 0; i < 3; i++) await publishedVideo({ title: `Clip ${i}` });
    const second = await api(viewer).get('/videos?page=2&pageSize=2');
    expect(second.body.data).toHaveLength(1);
    expect(second.body.meta).toEqual({ page: 2, pageSize: 2, total: 3, totalPages: 2 });
    expect((await api(viewer).get('/videos?pageSize=51')).status).toBe(400);
    expect((await api(viewer).get('/videos?page=201')).status).toBe(400);
    expect((await api(viewer).get('/videos?sort=title')).status).toBe(400);
  });

  it('treats operator-looking query values as plain data', async () => {
    const res = await api(viewer).get('/videos?categoryId[$ne]=x');
    expect(res.status).toBe(400);
  });

  it('requires a signed-in user', async () => {
    const { default: request } = await import('supertest');
    expect((await request(app).get('/api/v1/videos')).status).toBe(401);
  });
});

describe('audit log', () => {
  it('records every privileged change with actor, request id and details', async () => {
    const categoryId = await newCategory('Nature');
    const id = await publishedVideo({ categoryId });
    await api(admin).patch(`/videos/${id}`, { title: 'Renamed' });
    const res = await api(admin).get(`/admin/audit-logs?targetId=${id}`);
    expect(res.status).toBe(200);
    const actions = res.body.data.map((l: { action: string }) => l.action);
    expect(actions).toEqual(['video.updated', 'video.published', 'video.created']);
    const published = res.body.data[1];
    expect(published).toMatchObject({
      via: 'api',
      targetType: 'video',
      details: { from: 'DRAFT', to: 'PUBLISHED' },
    });
    expect(published.actorId).toMatch(/^[a-f0-9]{24}$/);
    expect(published.requestId).toBeTypeOf('string');
    expect(res.body.data[0].details).toEqual({ fields: 'title' });
  });

  it('a failed change is not recorded', async () => {
    const id = await newVideo();
    await api(admin).post(`/videos/${id}/publish`);
    expect(await AuditLogModel.countDocuments({ action: 'video.published' })).toBe(0);
  });

  it('only admins can read it', async () => {
    expect((await api(viewer).get('/admin/audit-logs')).status).toBe(403);
    expect((await api(admin).get('/admin/audit-logs?action=Video.Published')).status).toBe(400);
  });
});
