import type {
  Collection,
  Document,
  Filter,
  FindOptions,
  InsertOneResult,
  OptionalUnlessRequiredId,
  UpdateFilter,
  WithId,
  DeleteResult,
} from 'mongodb';
import { getDb } from '../core/database/client.js';

export abstract class BaseRepository<TDocument extends Document> {
  private readonly collectionName: string;
  private _collection?: Collection<TDocument>;

  constructor(collectionName: string) {
    this.collectionName = collectionName;
  }

  protected get collection(): Collection<TDocument> {
    this._collection ??= getDb().collection<TDocument>(this.collectionName);
    return this._collection;
  }

  async findOne(filter: Filter<TDocument>): Promise<WithId<TDocument> | null> {
    return this.collection.findOne(filter);
  }

  async findMany(
    filter: Filter<TDocument>,
    options?: FindOptions<TDocument>
  ): Promise<WithId<TDocument>[]> {
    return this.collection.find(filter, options).toArray();
  }

  async count(filter: Filter<TDocument>): Promise<number> {
    return this.collection.countDocuments(filter);
  }

  async insertOne(doc: OptionalUnlessRequiredId<TDocument>): Promise<InsertOneResult<TDocument>> {
    return this.collection.insertOne(doc);
  }

  async updateOne(
    filter: Filter<TDocument>,
    update: UpdateFilter<TDocument>
  ): Promise<boolean> {
    const result = await this.collection.updateOne(filter, update);
    return result.modifiedCount > 0;
  }

  async deleteOne(filter: Filter<TDocument>): Promise<DeleteResult> {
    return this.collection.deleteOne(filter);
  }

  async deleteMany(filter: Filter<TDocument>): Promise<DeleteResult> {
    return this.collection.deleteMany(filter);
  }
}
