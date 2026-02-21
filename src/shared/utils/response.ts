import type { Response } from 'express';
import type { Paginated } from '../types/common.js';

export function sendData<T>(res: Response, data: T, statusCode = 200): void {
  res.status(statusCode).json({ data });
}

export function sendPaginated<T>(res: Response, result: Paginated<T>): void {
  res.status(200).json(result);
}
