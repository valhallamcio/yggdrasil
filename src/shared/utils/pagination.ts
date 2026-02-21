import type { FindOptions, Document } from 'mongodb';

export interface PaginationParams {
  limit: number;
  skip: number;
}

export function buildFindOptions<T extends Document>(
  params: PaginationParams,
  sort: FindOptions<T>['sort'] = { _id: -1 }
): FindOptions<T> {
  return {
    limit: Math.min(params.limit, 100), // hard cap at 100
    skip: params.skip,
    sort,
  };
}

export function buildMeta(params: PaginationParams, total: number) {
  return {
    total,
    limit: params.limit,
    skip: params.skip,
  };
}
