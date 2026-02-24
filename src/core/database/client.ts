import { MongoClient, type Db } from 'mongodb';
import { config } from '../../config/index.js';
import { logger } from '../logger/index.js';

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectDatabase(): Promise<void> {
  client = new MongoClient(config.MONGODB_URI, {
    maxPoolSize: 20,
    minPoolSize: 5,
    connectTimeoutMS: 10_000,
    serverSelectionTimeoutMS: 10_000,
  });

  await client.connect();
  db = client.db(config.MONGODB_DB_NAME);
  logger.info({ db: config.MONGODB_DB_NAME }, 'Connected to MongoDB');
}

export function getDb(): Db {
  if (!db) throw new Error('Database not initialized. Call connectDatabase() first.');
  return db;
}

export function getClient(): MongoClient {
  if (!client) throw new Error('Database not initialized. Call connectDatabase() first.');
  return client;
}

export async function disconnectDatabase(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
    logger.info('Disconnected from MongoDB');
  }
}
