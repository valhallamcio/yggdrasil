export type Nullable<T> = T | null;

export type Optional<T> = T | undefined;

export interface Paginated<T> {
  data: T[];
  meta: {
    total: number;
    limit: number;
    skip: number;
  };
}

export interface ApiResponse<T> {
  data: T;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
