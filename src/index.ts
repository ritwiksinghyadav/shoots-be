import dotenv from 'dotenv';
import { sql } from 'drizzle-orm';
import app from './app.js';
import { db } from './db/index.js';

dotenv.config();

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);

  // Test database connection on server startup
  db.execute(sql`SELECT 1`)
    .then(() => {
      console.log('Database connected successfully.');
    })
    .catch((err) => {
      console.error('Database connection failed:', err);
    });
});
