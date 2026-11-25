import type { PaginationQuery } from '@streamhub/contracts';

/**
 * Offset pagination for list endpoints. The page size is capped by the
 * request schema (MAX_PAGE_SIZE), so no endpoint can return an unbounded
 * result set. Responses carry the paging state in `meta`.
 */
export type PageMeta = { page: number; pageSize: number; total: number; totalPages: number };

export const skipFor = ({ page, pageSize }: PaginationQuery) => (page - 1) * pageSize;

export function pageMeta({ page, pageSize }: PaginationQuery, total: number): PageMeta {
  return { page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}
