import type { Router } from 'express';
import { auditRouter } from './audit/audit.routes.ts';
import { categoriesRouter } from './categories/categories.routes.ts';
import { adminVideosRouter, videosRouter } from './videos/videos.routes.ts';

/**
 * Feature routes for categories, videos and audit logs. Mounted after the
 * auth pipeline (session, CSRF, current user), so every route here sees
 * req.user and is CSRF-protected for unsafe methods.
 */
export function catalogRoutes(): { path: string; router: Router }[] {
  return [
    { path: '/categories', router: categoriesRouter() },
    { path: '/videos', router: videosRouter() },
    { path: '/admin', router: adminVideosRouter() },
    { path: '/admin', router: auditRouter() },
  ];
}
