import { ObjectId } from 'mongodb';
import type { ExampleRepository } from './example.repository.js';
import type { ExampleDocument, ExampleDto } from './example.types.js';
import type { CreateExampleDto, UpdateExampleDto } from './example.schema.js';
import { NotFoundError, ConflictError } from '../../shared/errors/index.js';
import type { Paginated } from '../../shared/types/common.js';

function toDto(doc: ExampleDocument): ExampleDto {
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    ...(doc.description !== undefined && { description: doc.description }),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export class ExampleService {
  constructor(private readonly repo: ExampleRepository) {}

  async create(dto: CreateExampleDto): Promise<ExampleDto> {
    const existing = await this.repo.findByName(dto.name);
    if (existing) throw new ConflictError(`Example with name "${dto.name}" already exists`);

    const now = new Date();
    const doc: ExampleDocument = {
      _id: new ObjectId(),
      name: dto.name,
      ...(dto.description !== undefined && { description: dto.description }),
      createdAt: now,
      updatedAt: now,
    };

    await this.repo.insertOne(doc);
    return toDto(doc);
  }

  async findById(id: string): Promise<ExampleDto> {
    const doc = await this.repo.findOne({ _id: new ObjectId(id) });
    if (!doc) throw new NotFoundError('Example', id);
    return toDto(doc);
  }

  async findAll(limit: number, skip: number): Promise<Paginated<ExampleDto>> {
    const [docs, total] = await Promise.all([
      this.repo.findMany({}, { limit, skip, sort: { createdAt: -1 } }),
      this.repo.count({}),
    ]);
    return { data: docs.map(toDto), meta: { total, limit, skip } };
  }

  async update(id: string, dto: UpdateExampleDto): Promise<ExampleDto> {
    // Build the $set payload explicitly to satisfy strict typing
    const setPayload: Partial<ExampleDocument> & { updatedAt: Date } = { updatedAt: new Date() };
    if (dto.name !== undefined) setPayload.name = dto.name;
    if (dto.description !== undefined) setPayload.description = dto.description;

    const updated = await this.repo.updateOne({ _id: new ObjectId(id) }, { $set: setPayload });
    if (!updated) throw new NotFoundError('Example', id);
    return this.findById(id);
  }

  async delete(id: string): Promise<void> {
    const result = await this.repo.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) throw new NotFoundError('Example', id);
  }
}
