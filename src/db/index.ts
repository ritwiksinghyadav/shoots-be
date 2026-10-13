import { neon, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as dotenv from 'dotenv';
import * as schema from './schema.js';

dotenv.config();

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

// Local development and testing: a connection string on db.localtest.me goes
// to a local Postgres through the Neon HTTP proxy container on port 4444
// (ghcr.io/timowilhelm/local-neon-http-proxy). Real Neon hosts are unaffected.
if (new URL(process.env.DATABASE_URL).hostname === 'db.localtest.me') {
  neonConfig.fetchEndpoint = (host) => `http://${host}:4444/sql`;
}

const sql = neon(process.env.DATABASE_URL);
export const db = drizzle(sql, { schema });
