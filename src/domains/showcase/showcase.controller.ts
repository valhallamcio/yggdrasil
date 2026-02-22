import type { Request, Response } from 'express';
import type { ShowcaseService } from './showcase.service.js';
import type { ShowcaseQuery } from './showcase.schema.js';

export class ShowcaseController {
  constructor(private readonly service: ShowcaseService) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const { count } = req.query as unknown as ShowcaseQuery;
    const posts = await this.service.getScreenshots(count);
    res.json({ data: posts });
  };

  refresh = async (_req: Request, res: Response): Promise<void> => {
    const result = await this.service.refreshCache();
    res.json({ data: result });
  };
}
