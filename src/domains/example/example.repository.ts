import type { WithId } from 'mongodb';
import { BaseRepository } from '../../repositories/base.repository.js';
import type { ExampleDocument } from './example.types.js';

export class ExampleRepository extends BaseRepository<ExampleDocument> {
  constructor() {
    super('examples');
  }

  async findByName(name: string): Promise<WithId<ExampleDocument> | null> {
    return this.collection.findOne({ name });
  }
}
