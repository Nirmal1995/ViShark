import { PROCESSING_STATUSES, PUBLICATION_STATUSES, VISIBILITIES } from '@streamhub/shared';
import { z } from 'zod';

/**
 * Request shapes for categories, videos and audit logs. All objects are
 * strict: unknown fields are rejected (no mass assignment), and every list
 * is paginated with a hard upper bound (no unbounded queries).
 */
export const objectIdSchema = z
  .string()
  .regex(/^[a-f0-9]{24}$/, 'must be a valid id')
  .meta({ example: '6730c2f4a1b2c3d4e5f60718' });

export const idParamsSchema = z.strictObject({ id: objectIdSchema });

export const MAX_PAGE_SIZE = 50;
/** Deep offsets are slow and rarely useful; search or filters narrow results instead. */
export const MAX_PAGE = 200;

export const paginationQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(MAX_PAGE).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
});

// Categories

const categoryNameSchema = z.string().trim().min(2).max(50).meta({ example: 'Documentaries' });
const categoryDescriptionSchema = z.string().trim().max(300);

export const createCategoryBodySchema = z.strictObject({
  name: categoryNameSchema,
  description: categoryDescriptionSchema.default(''),
});

export const updateCategoryBodySchema = z
  .strictObject({
    name: categoryNameSchema.optional(),
    description: categoryDescriptionSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'nothing to update');

// Videos

const titleSchema = z.string().trim().min(1).max(120).meta({ example: 'Sunrise over Howth' });
const descriptionSchema = z.string().trim().max(5000);

export const createVideoBodySchema = z.strictObject({
  title: titleSchema,
  description: descriptionSchema.default(''),
  categoryId: objectIdSchema.nullable().default(null),
  visibility: z.enum(VISIBILITIES).default('PUBLIC'),
});

export const updateVideoBodySchema = z
  .strictObject({
    title: titleSchema.optional(),
    description: descriptionSchema.optional(),
    categoryId: objectIdSchema.nullable().optional(),
    visibility: z.enum(VISIBILITIES).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'nothing to update');

const searchSchema = z.string().trim().min(2).max(100);

/** Catalogue: what any signed-in user may browse. */
export const catalogueQuerySchema = paginationQuerySchema.extend({
  categoryId: objectIdSchema.optional(),
  q: searchSchema.optional(),
});

/** Management view: every state, for administrators. */
export const adminVideosQuerySchema = paginationQuerySchema.extend({
  categoryId: objectIdSchema.optional(),
  q: searchSchema.optional(),
  publicationStatus: z.enum(PUBLICATION_STATUSES).optional(),
  processingStatus: z.enum(PROCESSING_STATUSES).optional(),
});

// Audit logs

export const auditLogsQuerySchema = paginationQuerySchema.extend({
  action: z
    .string()
    .regex(/^[a-z]+(\.[a-z_]+)+$/, 'must look like "video.published"')
    .optional(),
  targetId: objectIdSchema.optional(),
  actorId: objectIdSchema.optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
export type CreateCategoryBody = z.infer<typeof createCategoryBodySchema>;
export type UpdateCategoryBody = z.infer<typeof updateCategoryBodySchema>;
export type CreateVideoBody = z.infer<typeof createVideoBodySchema>;
export type UpdateVideoBody = z.infer<typeof updateVideoBodySchema>;
export type CatalogueQuery = z.infer<typeof catalogueQuerySchema>;
export type AdminVideosQuery = z.infer<typeof adminVideosQuerySchema>;
export type AuditLogsQuery = z.infer<typeof auditLogsQuerySchema>;

// Response shapes (documentation and the web app; the API builds them in its DTO mappers)

export const pageMetaSchema = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
});

export const categoryDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string(),
});

const categoryRefSchema = categoryDtoSchema.pick({ id: true, name: true, slug: true }).nullable();

export const catalogueVideoDtoSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  category: categoryRefSchema,
  durationSeconds: z.number().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  publishedAt: z.string().nullable(),
});

export const adminVideoDtoSchema = catalogueVideoDtoSchema.extend({
  ownerId: z.string(),
  visibility: z.enum(VISIBILITIES),
  publicationStatus: z.enum(PUBLICATION_STATUSES),
  processingStatus: z.enum(PROCESSING_STATUSES),
  mimeType: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  failureReason: z.string().nullable(),
  hasFile: z.boolean(),
  hasThumbnail: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const auditLogDtoSchema = z.object({
  id: z.string(),
  actorId: z.string().nullable(),
  via: z.enum(['api', 'cli', 'system']),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  requestId: z.string().nullable(),
  ip: z.string().nullable(),
  createdAt: z.string(),
});
