import { Router, Response } from 'express';
import { eq, and, gt } from 'drizzle-orm';
import crypto from 'crypto';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import {
  hashPassword,
  comparePassword,
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken
} from '../utils/auth.js';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { sendSuccess, sendError } from '../utils/response.js';
import { sendPasswordResetEmail } from '../utils/email.js';

const router = Router();

// Helper to set refresh token cookie
const setRefreshTokenCookie = (res: Response, token: string) => {
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie('refreshToken', token, {
    httpOnly: true,
    secure: isProd,                       // HTTPS only in prod
    sameSite: isProd ? 'none' : 'lax',   // 'none' allows cross-site in prod (Vercel → Render)
    maxAge: 60 * 24 * 60 * 60 * 1000,   // 60 days in ms
  });
};

// POST /auth/register
router.post('/auth/register', async (req, res) => {
  console.log(`[POST] /auth/register request received for email: ${req.body?.email}`);
  try {
    const { name, email, password, businessName, invitedBy } = req.body;

    // 1. Validation
    const fields: Record<string, string> = {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      fields.name = 'Name is required';
    }
    if (!email || typeof email !== 'string' || !email.trim()) {
      fields.email = 'Email is required';
    }
    // Password is optional; validate only if provided
    if (password !== undefined && password !== null) {
      if (typeof password !== 'string' || password.length < 8) {
        fields.password = 'Password must be at least 8 characters';
      }
    }

    if (Object.keys(fields).length > 0) {
      return sendError(res, 400, {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        fields,
      });
    }

    const cleanEmail = email.trim().toLowerCase();

    // 2. Check if user already exists
    const [existingUser] = await db
      .select()
      .from(users)
      .where(eq(users.email, cleanEmail))
      .limit(1);

    if (existingUser) {
      return sendError(res, 409, {
        code: 'CONFLICT',
        message: 'An account with this email already exists',
      });
    }

    // 3. Hash password (if provided) & prepare data
    const passwordHash = password ? await hashPassword(password) : null;

    // 4. Insert user
    const [newUser] = await db
      .insert(users)
      .values({
        name: name.trim(),
        email: cleanEmail,
        passwordHash,
        businessName: businessName?.trim() || null,
        invitedBy: invitedBy || null,
      })
      .returning();

    // 5. Generate tokens
    const tokenPayload = { userId: newUser.id, email: newUser.email };
    const accessToken = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken(tokenPayload);

    // 6. Set cookie & return response
    setRefreshTokenCookie(res, refreshToken);

    const { passwordHash: _, ...userWithoutPassword } = newUser;
    return sendSuccess(res, 201, {
      user: userWithoutPassword,
      accessToken,
    }, 'User registered successfully');
  } catch (error) {
    console.error('Registration error:', error);
    return sendError(res, 500, {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred during registration',
    });
  }
});

// POST /auth/login
router.post('/auth/login', async (req, res) => {
  console.log(`[POST] /auth/login request received for email: ${req.body?.email}`);
  try {
    const { email, password } = req.body;

    // 1. Validation
    const fields: Record<string, string> = {};
    if (!email || typeof email !== 'string') {
      fields.email = 'Email is required';
    }
    if (!password || typeof password !== 'string') {
      fields.password = 'Password is required';
    }

    if (Object.keys(fields).length > 0) {
      return sendError(res, 400, {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        fields,
      });
    }

    const cleanEmail = email.trim().toLowerCase();

    // 2. Fetch user
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, cleanEmail))
      .limit(1);

    if (!user) {
      return sendError(res, 401, {
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });
    }

    // Check if the user has a password set (since password is optional on register/invitation)
    if (!user.passwordHash) {
      return sendError(res, 401, {
        code: 'PASSWORD_NOT_SET',
        message: 'Password has not been set for this account. Please set a password or use the invitation link.',
      });
    }

    // 3. Verify password
    const isPasswordValid = await comparePassword(password, user.passwordHash);
    if (!isPasswordValid) {
      return sendError(res, 401, {
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });
    }

    // 4. Generate tokens
    const tokenPayload = { userId: user.id, email: user.email };
    const accessToken = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken(tokenPayload);

    // 5. Set cookie & return response
    setRefreshTokenCookie(res, refreshToken);

    const { passwordHash: _, ...userWithoutPassword } = user;
    return sendSuccess(res, 200, {
      user: userWithoutPassword,
      accessToken,
    }, 'Logged in successfully');
  } catch (error) {
    console.error('Login error:', error);
    return sendError(res, 500, {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred during login',
    });
  }
});

// POST /auth/refresh
router.post('/auth/refresh', async (req, res) => {
  console.log('[POST] /auth/refresh request received');
  try {
    const refreshToken = req.cookies?.refreshToken;

    if (!refreshToken) {
      return sendError(res, 401, {
        code: 'UNAUTHORIZED',
        message: 'Refresh token is missing',
      });
    }

    // 1. Verify token
    let payload;
    try {
      payload = verifyRefreshToken(refreshToken);
    } catch (err) {
      return sendError(res, 401, {
        code: 'UNAUTHORIZED',
        message: 'Refresh token is invalid or expired',
      });
    }

    // 2. Look up user
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, payload.userId))
      .limit(1);

    if (!user) {
      return sendError(res, 401, {
        code: 'UNAUTHORIZED',
        message: 'User no longer exists',
      });
    }

    // 3. Rotate tokens (generate new access and refresh tokens)
    const tokenPayload = { userId: user.id, email: user.email };
    const newAccessToken = generateAccessToken(tokenPayload);
    const newRefreshToken = generateRefreshToken(tokenPayload);

    setRefreshTokenCookie(res, newRefreshToken);

    return sendSuccess(res, 200, {
      accessToken: newAccessToken,
    }, 'Token refreshed successfully');
  } catch (error) {
    console.error('Refresh token error:', error);
    return sendError(res, 500, {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred during token refresh',
    });
  }
});

// POST /auth/logout
router.post('/auth/logout', (req, res) => {
  const isProd = process.env.NODE_ENV === 'production';
  res.clearCookie('refreshToken', {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
  });
  return sendSuccess(res, 200, {}, 'Logged out successfully');
});

// GET /auth/me
router.get('/auth/me', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return sendError(res, 401, {
        code: 'UNAUTHORIZED',
        message: 'User identity could not be verified',
      });
    }

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      return sendError(res, 404, {
        code: 'NOT_FOUND',
        message: 'User not found',
      });
    }

    const { passwordHash: _, ...userWithoutPassword } = user;
    return sendSuccess(res, 200, {
      user: userWithoutPassword,
    }, 'User profile fetched successfully');
  } catch (error) {
    console.error('Get profile error:', error);
    return sendError(res, 500, {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred fetching profile',
    });
  }
});

// PUT /auth/me — update profile details
router.put('/auth/me', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return sendError(res, 401, {
        code: 'UNAUTHORIZED',
        message: 'User identity could not be verified',
      });
    }

    const { name, businessName, password, preferredCurrency } = req.body;

    // Validation
    const fields: Record<string, string> = {};
    if (name !== undefined && (!name || typeof name !== 'string' || !name.trim())) {
      fields.name = 'Name cannot be empty';
    }
    if (password !== undefined && password !== null && (typeof password !== 'string' || password.length < 8)) {
      fields.password = 'Password must be at least 8 characters';
    }
    const VALID_CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'AED', 'SGD', 'JPY', 'AUD', 'CAD', 'CHF', 'HKD', 'MYR', 'THB', 'NZD'];
    if (preferredCurrency !== undefined && !VALID_CURRENCIES.includes(preferredCurrency)) {
      fields.preferredCurrency = 'Invalid currency code';
    }

    if (Object.keys(fields).length > 0) {
      return sendError(res, 400, {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        fields,
      });
    }

    // Prepare update payload
    type UserUpdateData = Partial<Pick<typeof users.$inferInsert, 'name' | 'businessName' | 'preferredCurrency' | 'passwordHash'>> & { updatedAt: Date };
    const updatePayload: UserUpdateData = {
      updatedAt: new Date(),
    };
    if (name !== undefined) updatePayload.name = name.trim();
    if (businessName !== undefined) updatePayload.businessName = businessName?.trim() || null;
    if (preferredCurrency !== undefined) updatePayload.preferredCurrency = preferredCurrency;
    if (password !== undefined && password !== null) {
      updatePayload.passwordHash = await hashPassword(password);
    }

    const [updatedUser] = await db
      .update(users)
      .set(updatePayload)
      .where(eq(users.id, userId))
      .returning();

    if (!updatedUser) {
      return sendError(res, 404, {
        code: 'NOT_FOUND',
        message: 'User not found',
      });
    }

    const { passwordHash: _, ...userWithoutPassword } = updatedUser;
    return sendSuccess(res, 200, {
      user: userWithoutPassword,
    }, 'Profile updated successfully');
  } catch (error) {
    console.error('Update profile error:', error);
    return sendError(res, 500, {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred updating profile',
    });
  }
});


// GET /auth/verify-reset-token
router.get('/auth/verify-reset-token', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token || typeof token !== 'string') {
      return sendError(res, 400, {
        code: 'INVALID_TOKEN',
        message: 'Security token is missing or invalid.',
      });
    }

    const now = new Date();
    const [user] = await db
      .select({ email: users.email })
      .from(users)
      .where(
        and(
          eq(users.resetToken, token),
          gt(users.resetTokenExpiry, now)
        )
      )
      .limit(1);

    if (!user) {
      return sendError(res, 400, {
        code: 'INVALID_TOKEN',
        message: 'This password reset link is invalid or has expired.',
      });
    }

    return sendSuccess(res, 200, { valid: true, email: user.email }, 'Reset token is valid.');
  } catch (error) {
    console.error('Verify reset token error:', error);
    return sendError(res, 500, {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred while verifying the token.',
    });
  }
});

// POST /auth/forgot-password
router.post('/auth/forgot-password', async (req, res) => {
  console.log(`[POST] /auth/forgot-password request received for email: ${req.body?.email}`);
  try {
    const { email } = req.body;

    if (!email || typeof email !== 'string' || !email.trim()) {
      return sendError(res, 400, {
        code: 'VALIDATION_ERROR',
        message: 'Email is required',
        fields: { email: 'Email is required' },
      });
    }

    const cleanEmail = email.trim().toLowerCase();

    // Check if user is present
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, cleanEmail))
      .limit(1);

    if (!user) {
      return sendError(res, 404, {
        code: 'NOT_FOUND',
        message: 'No account found with this email address.',
        fields: { email: 'No account found with this email address.' },
      });
    }

    // Create one-time use token
    const token = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Patch to user
    await db
      .update(users)
      .set({
        resetToken: token,
        resetTokenExpiry: expiry,
      })
      .where(eq(users.id, user.id));

    // Send email
    const origin = req.headers.origin as string | undefined;
    const frontendUrl = process.env.FRONTEND_URL || origin || 'http://localhost:3005';
    const resetLink = `${frontendUrl}/reset-password?token=${token}`;
    
    const emailSent = await sendPasswordResetEmail(cleanEmail, resetLink);
    if (!emailSent) {
      return sendError(res, 500, {
        code: 'EMAIL_SEND_FAILED',
        message: 'Failed to send password reset email. Please try again later.',
      });
    }

    return sendSuccess(res, 200, {}, 'Password reset email sent successfully.');
  } catch (error) {
    console.error('Forgot password error:', error);
    return sendError(res, 500, {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred processing your request',
    });
  }
});

// POST /auth/reset-password
router.post('/auth/reset-password', async (req, res) => {
  console.log('[POST] /auth/reset-password request received');
  try {
    const { token, password, confirmPassword } = req.body;

    const fields: Record<string, string> = {};
    if (!token || typeof token !== 'string') {
      fields.token = 'Token is required';
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      fields.password = 'Password must be at least 8 characters';
    }
    if (password !== confirmPassword) {
      fields.confirmPassword = 'Passwords do not match';
    }

    if (Object.keys(fields).length > 0) {
      return sendError(res, 400, {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        fields,
      });
    }

    // Find the user with active token and expiry > current time
    const now = new Date();
    const [user] = await db
      .select()
      .from(users)
      .where(
        and(
          eq(users.resetToken, token),
          gt(users.resetTokenExpiry, now)
        )
      )
      .limit(1);

    if (!user) {
      return sendError(res, 400, {
        code: 'INVALID_TOKEN',
        message: 'Invalid or expired password reset link.',
      });
    }

    // Hash the password
    const newPasswordHash = await hashPassword(password);

    // Update user password and clear token
    await db
      .update(users)
      .set({
        passwordHash: newPasswordHash,
        resetToken: null,
        resetTokenExpiry: null,
      })
      .where(eq(users.id, user.id));

    return sendSuccess(res, 200, {}, 'Password reset successfully.');
  } catch (error) {
    console.error('Reset password error:', error);
    return sendError(res, 500, {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred while resetting your password.',
    });
  }
});

export default router;
