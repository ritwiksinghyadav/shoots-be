import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import authRouter from './routes/auth.js';
import { sendSuccess, sendError } from './utils/response.js';
import { db } from './db/index.js';
import { sql } from 'drizzle-orm';
import { requestLogger } from './middleware/logger.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// CORS setup supporting dynamic local development ports
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3005',
  process.env.FRONTEND_URL,
].filter(Boolean) as string[];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const isAllowed = allowedOrigins.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin);
      if (isAllowed) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
  })
);

app.use(requestLogger);
app.use(express.json());
app.use(cookieParser());

// Mount authentication and user profile routes
app.use('/api/v1', authRouter);

// Health check endpoint
app.get('/health', (req, res) => {
  sendSuccess(res, 200, { status: 'ok', timestamp: new Date() }, 'Health check success');
});

// Standardized 404 Route handler
app.use((req, res) => {
  sendError(res, 404, {
    code: 'NOT_FOUND',
    message: `Cannot ${req.method} ${req.url}`,
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
  
  // Test database connection on server startup
  db.execute(sql`SELECT 1`)
    .then(() => {
      console.log('Database connected successfully.');
    })
    .catch((err) => {
      console.error('Database connection failed:', err);
    });
});
