import { db } from './index.js';
import { sql } from 'drizzle-orm';

async function run() {
  console.log('Starting DB migration for triggers and GIN trigram indexes...');
  try {
    // 1. Enable pg_trgm extension
    console.log('Enabling pg_trgm extension...');
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);

    // 2. Create GIN Trigram indexes
    console.log('Creating GIN trigram indexes...');
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS projects_title_trgm_idx ON projects USING gin (lower(title) gin_trgm_ops);
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS projects_client_trgm_idx ON projects USING gin (lower(client) gin_trgm_ops);
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS shoot_days_location_name_trgm_idx ON shoot_days USING gin (lower(location_json->>'name') gin_trgm_ops);
    `);

    // 3. Create update timestamp trigger function
    console.log('Creating update timestamp trigger function...');
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
         NEW.updated_at = NOW();
         RETURN NEW;
      END;
      $$ language 'plpgsql';
    `);

    // 4. Attach trigger to tables
    const tables = ['users', 'projects', 'shoot_days', 'shoot_members', 'expenses', 'team_members'];
    for (const table of tables) {
      console.log(`Creating trigger for table: ${table}...`);
      await db.execute(sql`
        DROP TRIGGER IF EXISTS set_updated_at ON ${sql.raw(table)};
      `);
      await db.execute(sql`
        CREATE TRIGGER set_updated_at
        BEFORE UPDATE ON ${sql.raw(table)}
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column();
      `);
    }

    console.log('DB migration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

run();
