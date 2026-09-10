import { Response, NextFunction } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { AuthenticatedRequest } from './auth.js';
import { sendError } from '../utils/response.js';

/**
 * Must run after `requireAuth`. Looks the role up fresh from the DB on every
 * request (not from the JWT payload) so revoking admin access takes effect
 * immediately without waiting for the access token to expire or reissuing
 * tokens — same freshness principle as the ownership checks in routes/projects.ts.
 */
export async function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Authentication token is missing or invalid' });
    }

    const [user] = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user || user.role !== 'admin') {
      return sendError(res, 403, { code: 'FORBIDDEN', message: 'Admin access required' });
    }

    next();
  } catch (error) {
    console.error('Error checking admin role:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to verify admin access' });
  }
}
