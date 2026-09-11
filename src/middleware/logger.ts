import { Request, Response, NextFunction } from 'express';

const SENSITIVE_QUERY_PARAMS = ['token', 'password', 'currentPassword', 'newPassword', 'accessToken', 'refreshToken'];

/**
 * Redact bearer-style secrets (e.g. verify-reset-token's `token` param) out of a
 * request URL before it's written to logs — a live reset token in the access log
 * is as good as the account password to anyone who can read logs.
 */
function redactSensitiveQueryParams(originalUrl: string): string {
  const [path, query] = originalUrl.split('?');
  if (!query) return path;

  const params = new URLSearchParams(query);
  for (const key of SENSITIVE_QUERY_PARAMS) {
    if (params.has(key)) params.set(key, 'REDACTED');
  }
  return `${path}?${params.toString()}`;
}

/**
 * Middleware to log HTTP request details, including method, path, response status,
 * response time, and request metadata (IP and User-Agent).
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const { method, ip } = req;
  const originalUrl = redactSensitiveQueryParams(req.originalUrl);
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
