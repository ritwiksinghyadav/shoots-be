import { db } from './db/index.js';
import { sql } from 'drizzle-orm';

async function test() {
  try {
    console.log('Testing connection to Neon Postgres...');
    const result = await db.execute(sql`SELECT 1 as val`);
    console.log('Success! Connection established. Result:', result);
    process.exit(0);
  } catch (error) {
    console.error('Failed to connect to database:', error);
    process.exit(1);
  }
}

test();
