import type { ObjectId } from 'mongodb';

/** The shape of a document stored in MongoDB */
export interface ExampleDocument {
  _id: ObjectId;
  name: string;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** The shape returned by the API (serialized for JSON transport) */
export interface ExampleDto {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}
