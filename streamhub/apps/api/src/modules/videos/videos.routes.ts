import {
  adminVideosQuerySchema,
  catalogueQuerySchema,
  createVideoBodySchema,
  idParamsSchema,
  updateVideoBodySchema,
  type AdminVideosQuery,
  type CatalogueQuery,
  type CreateVideoBody,
  type UpdateVideoBody,
} from '@streamhub/contracts';
import { can, type PublicationStatus } from '@streamhub/shared';
import { Router } from 'express';
import { ok } from '../../common/http.ts';
import { requireAuth, requirePermission } from '../../middleware/authenticate.ts';
import { validate } from '../../middleware/validate.ts';
import { audit } from '../audit/audit.service.ts';
import * as videos from './videos.service.ts';

type IdParams = { params: { id: string } };

/**
 * /videos: the catalogue for every signed-in user, plus management actions
 * that need `video:manage`. The management list lives at /admin/videos
 * (adminVideosRouter) so the catalogue endpoint has one meaning.
 */
export function videosRouter(): Router {
  const router = Router();
  const manage = [requireAuth, requirePermission('video:manage')];

  router.get(
    '/',
    requireAuth,
    requirePermission('video:read'),
    validate({ query: catalogueQuerySchema }),
    async (_req, res) => {
      const { query } = res.locals.validated as { query: CatalogueQuery };
      const { items, meta } = await videos.listCatalogue(query);
      res.json(ok(items, meta));
    },
  );

  router.get(
    '/:id',
    requireAuth,
    requirePermission('video:read'),
    validate({ params: idParamsSchema }),
    async (req, res) => {
      const { params } = res.locals.validated as IdParams;
      res.json(ok(await videos.getVideo(params.id, can(req.user!.role, 'video:manage'))));
    },
  );

  router.post('/', ...manage, validate({ body: createVideoBodySchema }), async (req, res) => {
    const { body } = res.locals.validated as { body: CreateVideoBody };
    const video = await videos.createVideo(req.user!._id, body);
    await audit(req, {
      action: 'video.created',
      targetType: 'video',
      targetId: video.id,
      details: { title: video.title },
    });
    res.status(201).json(ok(video));
  });

  router.patch(
    '/:id',
    ...manage,
    validate({ params: idParamsSchema, body: updateVideoBodySchema }),
    async (req, res) => {
      const { params, body } = res.locals.validated as IdParams & { body: UpdateVideoBody };
      const { video, changed } = await videos.updateVideo(params.id, body);
      await audit(req, {
        action: 'video.updated',
        targetType: 'video',
        targetId: params.id,
        details: { fields: changed.join(',') },
      });
      res.json(ok(video));
    },
  );

  router.delete('/:id', ...manage, validate({ params: idParamsSchema }), async (req, res) => {
    const { params } = res.locals.validated as IdParams;
    const { title } = await videos.softDeleteVideo(params.id);
    await audit(req, {
      action: 'video.deleted',
      targetType: 'video',
      targetId: params.id,
      details: { title },
    });
    res.status(204).end();
  });

  // [path, from (null = any allowed state), to, audit action]
  const transitions: [string, PublicationStatus | null, PublicationStatus, string][] = [
    ['publish', null, 'PUBLISHED', 'video.published'],
    ['unpublish', 'PUBLISHED', 'DRAFT', 'video.unpublished'],
    ['archive', null, 'ARCHIVED', 'video.archived'],
    ['restore', 'ARCHIVED', 'DRAFT', 'video.restored'],
  ];
  for (const [path, from, to, action] of transitions) {
    router.post(
      `/:id/${path}`,
      ...manage,
      validate({ params: idParamsSchema }),
      async (req, res) => {
        const { params } = res.locals.validated as IdParams;
        const change = await videos.changePublication(params.id, to, from);
        await audit(req, { action, targetType: 'video', targetId: params.id, details: change });
        res.json(ok(await videos.getVideo(params.id, true)));
      },
    );
  }

  return router;
}

/** GET /admin/videos: every non-deleted video in any state. */
export function adminVideosRouter(): Router {
  const router = Router();
  router.get(
    '/videos',
    requireAuth,
    requirePermission('video:manage'),
    validate({ query: adminVideosQuerySchema }),
    async (_req, res) => {
      const { query } = res.locals.validated as { query: AdminVideosQuery };
      const { items, meta } = await videos.listForAdmin(query);
      res.set('Cache-Control', 'no-store').json(ok(items, meta));
    },
  );
  return router;
}
