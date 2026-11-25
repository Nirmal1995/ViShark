import { describe, expect, it } from 'vitest';
import {
  adminVideosQuerySchema,
  catalogueQuerySchema,
  createCategoryBodySchema,
  createVideoBodySchema,
  idParamsSchema,
  updateVideoBodySchema,
} from './catalog.ts';

describe('catalog request schemas', () => {
  it('accepts only 24-hex ids', () => {
    expect(idParamsSchema.safeParse({ id: '6730c2f4a1b2c3d4e5f60718' }).success).toBe(true);
    for (const id of ['x', '6730C2F4A1B2C3D4E5F60718', { $ne: null }, '6730c2f4a1b2c3d4e5f6071']) {
      expect(idParamsSchema.safeParse({ id }).success).toBe(false);
    }
  });

  it('defaults and bounds pagination', () => {
    expect(catalogueQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(catalogueQuerySchema.parse({ page: '3', pageSize: '50' })).toMatchObject({
      page: 3,
      pageSize: 50,
    });
    for (const q of [{ pageSize: '51' }, { page: '0' }, { page: '201' }, { page: '1.5' }]) {
      expect(catalogueQuerySchema.safeParse(q).success).toBe(false);
    }
  });

  it('keeps management filters out of the catalogue query', () => {
    expect(catalogueQuerySchema.safeParse({ publicationStatus: 'DRAFT' }).success).toBe(false);
    expect(adminVideosQuerySchema.safeParse({ publicationStatus: 'DRAFT' }).success).toBe(true);
  });

  it('rejects fields a client must never set (mass assignment)', () => {
    for (const extra of [{ ownerId: 'x' }, { processingStatus: 'READY' }, { storageKey: 'k' }]) {
      expect(createVideoBodySchema.safeParse({ title: 't', ...extra }).success).toBe(false);
    }
    expect(updateVideoBodySchema.safeParse({}).success).toBe(false);
  });

  it('applies video defaults and trims input', () => {
    expect(createVideoBodySchema.parse({ title: '  Cliffs ' })).toEqual({
      title: 'Cliffs',
      description: '',
      categoryId: null,
      visibility: 'PUBLIC',
    });
    expect(createCategoryBodySchema.safeParse({ name: 'a' }).success).toBe(false);
  });
});
