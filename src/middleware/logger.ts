import { Request, Response, NextFunction } from 'express';

/**
 * Middleware to log HTTP request details, including method, path, response status,
 * response time, and request metadata (IP and User-Agent).
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const { method, originalUrl, ip } = req;
  const userAgent = req.get('user-agent') || 'unknown';

  res.on('finish', () => {
    const duration = Date.now() - start;
    const { statusCode } = res;
    const timestamp = new Date().toISOString();

    // Use appropriate console level based on response status code
    let logFn = console.log;
    if (statusCode >= 500) {
      logFn = console.error;
    } else if (statusCode >= 400) {
      logFn = console.warn;
    }

    logFn(`[${timestamp}] [API] ${method} ${originalUrl} ${statusCode} - ${duration}ms - IP: ${ip} - UA: ${userAgent}`);
  });

  next();
}
