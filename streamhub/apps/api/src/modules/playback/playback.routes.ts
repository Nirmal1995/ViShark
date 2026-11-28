import {
  idParamsSchema,
  paginationQuerySchema,
  progressBodySchema,
  type PaginationQuery,
  type ProgressBody,
} from '@streamhub/contracts';
import { Router, type Request } from 'express';
import type { Redis } from 'ioredis';
import { ok } from '../../common/http.ts';
import { requireAuth, requirePermission } from '../../middleware/authenticate.ts';
import { rateLimit } from '../../middleware/rate-limit.ts';
import { validate } from '../../middleware/validate.ts';
import type { PlaybackService } from './playback.service.ts';

type IdParams = { params: { id: string } };
const perUser = (req: Request) => req.user!._id.toString();

/** /videos/:id/playback, /progress and /favourite. */
export function playbackRouter(playback: PlaybackService, redis: Redis): Router {
  const router = Router();

  router.get(
    '/:id/playback',
    requireAuth,
    requirePermission('video:read'),
    // Every signed URL is a capability: keep minting them bounded.
    rateLimit({ redis, name: 'playback', limit: 60, windowSeconds: 60, key: perUser }),
    validate({ params: idParamsSchema }),
    async (req, res) => {
      const { params } = res.locals.validated as IdParams;
      res.json(ok(await playback.getPlayback(req.user!, params.id)));
    },
  );

  router.put(
    '/:id/progress',
    requireAuth,
    requirePermission('history:manage-own'),
    // The player reports every 30 to 60 seconds; this allows seeking bursts.
    rateLimit({ redis, name: 'progress', limit: 30, windowSeconds: 60, key: perUser }),
    validate({ params: idParamsSchema, body: progressBodySchema }),
    async (req, res) => {
      const { params, body } = res.locals.validated as IdParams & { body: ProgressBody };
      await playback.saveProgress(req.user!, params.id, body.positionSeconds);
      res.status(204).end();
    },
  );

  router.put(
    '/:id/favourite',
    requireAuth,
    requirePermission('favourites:manage-own'),
    validate({ params: idParamsSchema }),
    async (req, res) => {
      const { params } = res.locals.validated as IdParams;
      await playback.addFavourite(req.user!._id, params.id);
      res.status(204).end();
    },
  );

  router.delete(
    '/:id/favourite',
    requireAuth,
    requirePermission('favourites:manage-own'),
    validate({ params: idParamsSchema }),
    async (req, res) => {
      const { params } = res.locals.validated as IdParams;
      await playback.removeFavourite(req.user!._id, params.id);
      res.status(204).end();
    },
  );

  return router;
}

/** /users/me/history and /users/me/favourites. */
export function libraryRouter(playback: PlaybackService): Router {
  const router = Router();

  router.get(
    '/history',
    requireAuth,
    requirePermission('history:manage-own'),
    validate({ query: paginationQuerySchema }),
    async (req, res) => {
      const { query } = res.locals.validated as { query: PaginationQuery };
      const { items, meta } = await playback.listHistory(req.user!._id, query);
      res.json(ok(items, meta));
    },
  );

  router.delete(
    '/history/:id',
    requireAuth,
    requirePermission('history:manage-own'),
    validate({ params: idParamsSchema }),
    async (req, res) => {
      const { params } = res.locals.validated as IdParams;
      await playback.removeHistory(req.user!._id, params.id);
      res.status(204).end();
    },
  );

  router.get(
    '/favourites',
    requireAuth,
    requirePermission('favourites:manage-own'),
    validate({ query: paginationQuerySchema }),
    async (req, res) => {
      const { query } = res.locals.validated as { query: PaginationQuery };
      const { items, meta } = await playback.listFavourites(req.user!._id, query);
      res.json(ok(items, meta));
    },
  );

  return router;
}
