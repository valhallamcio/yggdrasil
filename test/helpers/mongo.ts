import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';

export interface TestMongo {
  client: MongoClient;
  uri: string;
  stop: () => Promise<void>;
}

/**
 * In-memory MongoDB for DB-backed tests (ops store, policies, persistence).
 * First run downloads a mongod binary into ~/.cache/mongodb-binaries — that's why
 * DB tests live under test/db/ (npm run test:db), separate from the fast `npm test`.
 */
export async function startTestMongo(): Promise<TestMongo> {
  const mem = await MongoMemoryServer.create();
  const uri = mem.getUri();
  const client = new MongoClient(uri);
  await client.connect();
  return {
    client,
    uri,
    stop: async () => {
      await client.close();
      await mem.stop();
    },
  };
}
