import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, JWTPayload } from '../utils/auth.js';
import { sendError } from '../utils/response.js';

export interface AuthenticatedRequest extends Request {
  user?: JWTPayload;
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return sendError(res, 401, {
      code: 'UNAUTHORIZED',
      message: 'Authentication token is missing or invalid',
    });
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload = verifyAccessToken(token);
    req.user = payload;
    next();
  } catch (error) {
    return sendError(res, 401, {
      code: 'UNAUTHORIZED',
      message: 'Authentication token is invalid or expired',
    });
  }
}
