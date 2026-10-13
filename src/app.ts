// The Express app, without starting a server: index.ts listens, tests import this.
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import helmet from 'helmet';
import authRouter from './routes/auth.js';
import projectsRouter from './routes/projects.js';
import feedbackRouter from './routes/feedback.js';
import publicRouter from './routes/public.js';
import adminRouter from './routes/admin.js';
import billingRouter, { razorpayWebhook } from './routes/billing.js';
import { sendSuccess, sendError } from './utils/response.js';
import { requestLogger } from './middleware/logger.js';

dotenv.config();

const app = express();
// Render sits one proxy hop in front; without this every client shares the
// proxy's IP and the rate limits would apply to everyone at once.
app.set('trust proxy', 1);
app.use(helmet());

// CORS setup supporting dynamic local development ports
const allowedOrigins = [
  'http://localhost:3005',
  'https://shoots-eta.vercel.app',
  'https://shoots.bnwapphub.com',
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
        // A browser on an unknown site: refuse with 403, not a 500 that reads as a crash.
        callback(Object.assign(new Error('Not allowed by CORS'), { statusCode: 403, code: 'CORS_FORBIDDEN' }));
      }
    },
    credentials: true,
  })
);

app.use(requestLogger);
// Before express.json(): the webhook signature is over the raw bytes.
app.post('/api/v1/billing/webhook', express.raw({ type: 'application/json', limit: '1mb' }), razorpayWebhook);
app.use(express.json());
app.use(cookieParser());

// Mount API routes
app.use('/api/v1', authRouter);
app.use('/api/v1', publicRouter);
app.use('/api/v1', projectsRouter);
app.use('/api/v1', feedbackRouter);
app.use('/api/v1', billingRouter);
app.use('/api/v1', adminRouter);

// Health check endpoint
app.get('/health', (req, res) => {
  sendSuccess(res, 200, { status: 'ok', timestamp: new Date() }, 'Health check success');
});

// Global error handler — prevents unhandled errors from leaking stack traces
// IMPORTANT: This must be defined AFTER all routes
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Structured error from sendError-style middleware
  if ('statusCode' in err && typeof err.statusCode === 'number') {
    if (err.statusCode >= 500) console.error('[Global Error Handler]', err);
    else console.warn(`[Global Error Handler] ${err.statusCode} ${req.method} ${req.originalUrl}: ${err.message}`);
    return res.status(err.statusCode as number).json({
      success: false,
      error: {
        code: (err as any).code || 'INTERNAL_SERVER_ERROR',
        message: err.message,
      },
      statusCode: err.statusCode,
    });
  }

  // Details go to the server log only; callers never see messages or stack traces.
  console.error('[Global Error Handler]', err);
  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
    },
    statusCode: 500,
  });
});

// Standardized 404 Route handler
app.use((req, res) => {
  sendError(res, 404, {
    code: 'NOT_FOUND',
    message: `Cannot ${req.method} ${req.url}`,
  });
});

export default app;
