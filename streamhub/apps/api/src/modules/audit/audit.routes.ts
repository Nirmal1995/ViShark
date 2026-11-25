import { auditLogsQuerySchema, type AuditLogsQuery } from '@streamhub/contracts';
import { Router } from 'express';
import { ok } from '../../common/http.ts';
import { pageMeta, skipFor } from '../../common/pagination.ts';
import { requireAuth, requirePermission } from '../../middleware/authenticate.ts';
import { validate } from '../../middleware/validate.ts';
import { AuditLogModel } from './audit.model.ts';

/** GET /admin/audit-logs: newest first, filterable, paginated. */
export function auditRouter(): Router {
  const router = Router();
  router.get(
    '/audit-logs',
    requireAuth,
    requirePermission('audit:read'),
    validate({ query: auditLogsQuerySchema }),
    async (_req, res) => {
      const { query } = res.locals.validated as { query: AuditLogsQuery };
      const filter: Record<string, unknown> = {};
      if (query.action) filter.action = query.action;
      if (query.targetId) filter.targetId = query.targetId;
      if (query.actorId) filter.actorId = query.actorId;
      const [items, total] = await Promise.all([
        AuditLogModel.find(filter)
          .sort({ createdAt: -1, _id: -1 })
          .skip(skipFor(query))
          .limit(query.pageSize)
          .lean(),
        AuditLogModel.countDocuments(filter),
      ]);
      res.set('Cache-Control', 'no-store').json(
        ok(
          items.map((log) => ({
            id: log._id.toString(),
            actorId: log.actorId?.toString() ?? null,
            via: log.via,
            action: log.action,
            targetType: log.targetType,
            targetId: log.targetId?.toString() ?? null,
            details: log.details as Record<string, unknown>,
            requestId: log.requestId,
            ip: log.ip,
            createdAt: log.createdAt.toISOString(),
          })),
          pageMeta(query, total),
        ),
      );
    },
  );
  return router;
}
