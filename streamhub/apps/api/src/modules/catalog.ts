import type { Router } from 'express';
import { auditRouter } from './audit/audit.routes.ts';
import { categoriesRouter } from './categories/categories.routes.ts';
import type { Redis } from 'ioredis';
import { libraryRouter, playbackRouter } from './playback/playback.routes.ts';
import type { PlaybackService } from './playback/playback.service.ts';
import type { UploadsService } from './uploads/uploads.service.ts';
import { uploadsRouter } from './uploads/uploads.routes.ts';
import { adminVideosRouter, videosRouter } from './videos/videos.routes.ts';

/**
 * Feature routes for categories, videos, uploads, playback, the user's
 * library (history, favourites) and audit logs. Mounted after the
 * auth pipeline (session, CSRF, current user), so every route here sees
 * req.user and is CSRF-protected for unsafe methods.
 */
export function catalogRoutes(deps: {
  uploads: UploadsService;
  playback: PlaybackService;
  redis: Redis;
}): {
  path: string;
  router: Router;
}[] {
  return [
    { path: '/categories', router: categoriesRouter() },
    { path: '/videos', router: videosRouter() },
    { path: '/videos', router: playbackRouter(deps.playback, deps.redis) },
    { path: '/users/me', router: libraryRouter(deps.playback) },
    { path: '/admin', router: adminVideosRouter() },
    { path: '/admin', router: uploadsRouter(deps.uploads) },
    { path: '/admin', router: auditRouter() },
  ];
}
