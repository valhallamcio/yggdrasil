import 'dotenv/config';
import { configSchema } from './schema.js';

const parseResult = configSchema.safeParse(process.env);

if (!parseResult.success) {
  console.error('Invalid environment configuration:');
  console.error(JSON.stringify(parseResult.error.flatten().fieldErrors, null, 2));
  process.exit(1);
}

export const config = parseResult.data;
export type { Config } from './schema.js';
