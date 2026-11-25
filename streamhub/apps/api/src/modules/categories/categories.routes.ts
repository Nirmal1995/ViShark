import {
  createCategoryBodySchema,
  idParamsSchema,
  updateCategoryBodySchema,
  type CreateCategoryBody,
  type UpdateCategoryBody,
} from '@streamhub/contracts';
import { Router } from 'express';
import { AppError, badRequest, notFound } from '../../common/errors.ts';
import { ok } from '../../common/http.ts';
import { requireAuth, requirePermission } from '../../middleware/authenticate.ts';
import { validate } from '../../middleware/validate.ts';
import { audit } from '../audit/audit.service.ts';
import { VideoModel } from '../videos/video.model.ts';
import { CategoryModel, slugify, type Category } from './category.model.ts';

/** Categories are a small, admin-curated list; this cap keeps the list query bounded. */
export const MAX_CATEGORIES = 200;

const categoryExists = () =>
  new AppError(409, 'CATEGORY_EXISTS', 'A category with this name already exists');

const isDuplicateKey = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;

type CategoryLike = Category & { _id: { toString(): string } };
export const toCategoryDto = (c: CategoryLike) => ({
  id: c._id.toString(),
  name: c.name,
  slug: c.slug,
  description: c.description,
});

function slugOrThrow(name: string): string {
  const slug = slugify(name);
  if (slug.length < 2) throw badRequest('Category name must contain letters or digits');
  return slug;
}

export function categoriesRouter(): Router {
  const router = Router();

  router.get('/', requireAuth, requirePermission('video:read'), async (_req, res) => {
    const categories = await CategoryModel.find().sort({ name: 1 }).limit(MAX_CATEGORIES).lean();
    res.json(ok(categories.map(toCategoryDto)));
  });

  router.post(
    '/',
    requireAuth,
    requirePermission('category:manage'),
    validate({ body: createCategoryBodySchema }),
    async (req, res) => {
      const { body } = res.locals.validated as { body: CreateCategoryBody };
      if ((await CategoryModel.estimatedDocumentCount()) >= MAX_CATEGORIES) {
        throw new AppError(409, 'CATEGORY_LIMIT', `At most ${MAX_CATEGORIES} categories`);
      }
      let category;
      try {
        category = await CategoryModel.create({
          name: body.name,
          slug: slugOrThrow(body.name),
          description: body.description,
        });
      } catch (err) {
        if (isDuplicateKey(err)) throw categoryExists();
        throw err;
      }
      await audit(req, {
        action: 'category.created',
        targetType: 'category',
        targetId: category._id,
        details: { name: category.name },
      });
      res.status(201).json(ok(toCategoryDto(category)));
    },
  );

  router.patch(
    '/:id',
    requireAuth,
    requirePermission('category:manage'),
    validate({ params: idParamsSchema, body: updateCategoryBodySchema }),
    async (req, res) => {
      const { params, body } = res.locals.validated as {
        params: { id: string };
        body: UpdateCategoryBody;
      };
      const set: Partial<Category> = {};
      if (body.name !== undefined)
        Object.assign(set, { name: body.name, slug: slugOrThrow(body.name) });
      if (body.description !== undefined) set.description = body.description;
      let updated;
      try {
        updated = await CategoryModel.findByIdAndUpdate(
          params.id,
          { $set: set },
          { returnDocument: 'after', runValidators: true },
        ).lean();
      } catch (err) {
        if (isDuplicateKey(err)) throw categoryExists();
        throw err;
      }
      if (!updated) throw notFound();
      await audit(req, {
        action: 'category.updated',
        targetType: 'category',
        targetId: updated._id,
        details: { name: updated.name },
      });
      res.json(ok(toCategoryDto(updated)));
    },
  );

  router.delete(
    '/:id',
    requireAuth,
    requirePermission('category:manage'),
    validate({ params: idParamsSchema }),
    async (req, res) => {
      const { params } = res.locals.validated as { params: { id: string } };
      // Refuse while videos still use it, rather than leaving dangling references.
      const inUse = await VideoModel.countDocuments({ categoryId: params.id, deletedAt: null });
      if (inUse > 0) {
        throw new AppError(
          409,
          'CATEGORY_IN_USE',
          `The category is used by ${inUse} video(s); move them to another category first`,
        );
      }
      const deleted = await CategoryModel.findByIdAndDelete(params.id).lean();
      if (!deleted) throw notFound();
      await audit(req, {
        action: 'category.deleted',
        targetType: 'category',
        targetId: deleted._id,
        details: { name: deleted.name },
      });
      res.status(204).end();
    },
  );

  return router;
}
