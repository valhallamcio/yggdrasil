import type { Request, Response } from 'express';
import type { ExampleService } from './example.service.js';
import type { CreateExampleDto, UpdateExampleDto } from './example.schema.js';

// Controllers are intentionally thin — they translate HTTP in/out and delegate to the service.
// No business logic, no direct DB access.
export class ExampleController {
  constructor(private readonly service: ExampleService) {}

  create = async (req: Request, res: Response): Promise<void> => {
    const dto = req.body as CreateExampleDto;
    const result = await this.service.create(dto);
    res.status(201).json({ data: result });
  };

  getAll = async (req: Request, res: Response): Promise<void> => {
    const { limit, skip } = req.query as unknown as { limit: number; skip: number };
    const result = await this.service.findAll(limit, skip);
    res.json(result);
  };

  getById = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string };
    const result = await this.service.findById(id);
    res.json({ data: result });
  };

  update = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string };
    const dto = req.body as UpdateExampleDto;
    const result = await this.service.update(id, dto);
    res.json({ data: result });
  };

  delete = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string };
    await this.service.delete(id);
    res.status(204).send();
  };
}
