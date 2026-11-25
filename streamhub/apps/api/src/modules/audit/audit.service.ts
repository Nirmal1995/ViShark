import type { Request } from 'express';
import type { Types } from 'mongoose';
import { AuditLogModel } from './audit.model.ts';

type Detail = string | number | boolean | null;

export type AuditEntry = {
  action: string;
  targetType: 'video' | 'category' | 'user';
  targetId?: Types.ObjectId | string | null;
  details?: Record<string, Detail>;
};

/**
 * Records a privileged change. Called after the change succeeded, and awaited:
 * if the audit record cannot be written, the request fails loudly (500)
 * instead of leaving an unrecorded change looking like a success.
 */
export async function audit(req: Request, entry: AuditEntry): Promise<void> {
  await AuditLogModel.create({
    actorId: req.user?._id ?? null,
    via: 'api',
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
    details: entry.details ?? {},
    requestId: req.requestId,
    ip: req.ip ?? null,
  });
  req.log.info(
    {
      event: entry.action,
      targetId: entry.targetId?.toString() ?? null,
      actorId: req.user?._id.toString(),
    },
    'audit',
  );
}

/** Same record for server-side tools (admin CLI), which have no request. */
export async function auditCli(entry: AuditEntry): Promise<void> {
  await AuditLogModel.create({
    actorId: null,
    via: 'cli',
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
    details: entry.details ?? {},
  });
}
