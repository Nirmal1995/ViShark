import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

/**
 * auditLogs collection: who changed what, when, from where. Append-only: the
 * application never updates or deletes these documents.
 *
 * `details` holds a small, explicit set of non-sensitive fields chosen by the
 * caller (for example the old and new status), never request bodies,
 * passwords or tokens.
 */
const auditLogSchema = new Schema(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    /** "cli" for server-side tools, "api" for requests. */
    via: { type: String, enum: ['api', 'cli', 'system'], required: true },
    action: { type: String, required: true, maxlength: 60 },
    targetType: { type: String, required: true, maxlength: 30 },
    targetId: { type: Schema.Types.ObjectId, default: null },
    details: { type: Schema.Types.Mixed, default: {} },
    requestId: { type: String, default: null },
    ip: { type: String, default: null },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { versionKey: false, collection: 'auditLogs' },
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ targetId: 1, createdAt: -1 });
auditLogSchema.index({ actorId: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });

export type AuditLog = InferSchemaType<typeof auditLogSchema>;
export const AuditLogModel: Model<AuditLog> =
  (mongoose.models.AuditLog as Model<AuditLog> | undefined) ??
  mongoose.model<AuditLog>('AuditLog', auditLogSchema);
