import { Router, Response } from 'express';
import { eq, and, gt, isNull } from 'drizzle-orm';
import crypto from 'crypto';
import { db } from '../db/index.js';
import { users, refreshSessions } from '../db/schema.js';
import {
  hashPassword,
  comparePassword,
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken
} from '../utils/auth.js';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { sendSuccess, sendError } from '../utils/response.js';
import { sendPasswordResetEmail, sendSignupVerificationEmail } from '../utils/email.js';

const router = Router();

type UserRow = typeof users.$inferSelect;

/**
 * Shapes a raw `users` row for API responses: strips the password hash and
 * converts the `first_login` smallint column to a proper JSON boolean.
 *
 * IMPORTANT — the column defaults to 1 for every newly created account
 * (both self-registered and auto-created-via-invite), meaning "this
 * account's first login is still pending". So `1` → API `false` ("hasn't
 * completed onboarding yet") and `0` → API `true` ("has completed it").
 * This is the inverse of the naive 1=true/0=false reading — get it backwards
 * and every brand-new account reports as already onboarded.
 */
export function serializeUser(user: UserRow) {
  const { passwordHash: _passwordHash, firstLogin, ...rest } = user;
  return { ...rest, firstLogin: firstLogin === 0 };
}

const REFRESH_TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days — matches generateRefreshToken

/**
 * Opens a new signed-in session for a user and returns the token pair for it.
 * The session row's id rides along as the refresh token's `jti`, which is what
 * makes that one session revocable without touching the user's other devices.
 */
async function issueSessionTokens(user: Pick<UserRow, 'id' | 'email'>) {
  const [session] = await db
    .insert(refreshSessions)
    .values({ userId: user.id, expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS) })
    .returning({ id: refreshSessions.id });

  const tokenPayload = { userId: user.id, email: user.email, jti: session.id };
  return {
    accessToken: generateAccessToken({ userId: user.id, email: user.email }),
    refreshToken: generateRefreshToken(tokenPayload),
  };
}

/** Revokes every active session for a user — used when the password changes. */
async function revokeAllSessions(userId: string) {
  await db
    .update(refreshSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshSessions.userId, userId), isNull(refreshSessions.revokedAt)));
}

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
    const { accessToken, refreshToken } = await issueSessionTokens(newUser);

    // 6. Set cookie & return response
    setRefreshTokenCookie(res, refreshToken);

    return sendSuccess(res, 201, {
      user: serializeUser(newUser),
      accessToken,
      refreshToken,
    }, 'User registered successfully');
  } catch (error) {
    console.error('Registration error:', error);
    return sendError(res, 500, {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred during registration',
    });
  }
});

// POST /auth/signup-request — step 1 of the email-first signup flow: check
// the email, and if it can't sign in yet, (re)send a verify-and-set-password
// link. Reuses the exact same resetToken/resetTokenExpiry mechanism as
// forgot-password — a crew member invited before ever signing up already
// goes through this same "no password yet, click a link to set one" path,
// so this just reuses that instead of building parallel plumbing.
router.post('/auth/signup-request', async (req, res) => {
  console.log(`[POST] /auth/signup-request request received for email: ${req.body?.email}`);
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

    let [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, cleanEmail))
      .limit(1);

    // A real, usable account already exists — nothing to verify, they
    // should sign in instead.
    if (user && user.passwordHash) {
      return sendSuccess(res, 200, { requiresSignIn: true }, 'An account with this email already exists.');
    }

    // No row yet — create the placeholder now (mirrors the row the invite
    // flow creates for an email added to a project before it ever signs up).
    if (!user) {
      [user] = await db
        .insert(users)
        .values({ email: cleanEmail })
        .returning();
    }

    // Either brand new, or an existing invited-but-never-signed-up row —
    // both need the same "click to verify and set a password" link.
    const token = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await db
      .update(users)
      .set({ resetToken: token, resetTokenExpiry: expiry })
      .where(eq(users.id, user.id));

    const origin = req.headers.origin as string | undefined;
    const frontendUrl = process.env.FRONTEND_URL || origin || 'http://localhost:3005';
    // `signup=1` lets the reset-password page phrase its expired/invalid-link
    // screen as "resume signup" rather than "request a password reset" even
    // when the token itself can no longer tell it that (verify-token has
    // nothing to look up once the token's already invalid).
    const verifyLink = `${frontendUrl}/reset-password?token=${token}&signup=1`;

    const emailSent = await sendSignupVerificationEmail(cleanEmail, verifyLink);
    if (!emailSent) {
      console.error(`Signup request: failed to send verification email to ${cleanEmail}`);
    }

    return sendSuccess(res, 200, { requiresSignIn: false }, 'Verification email sent.');
  } catch (error) {
    console.error('Signup request error:', error);
    return sendError(res, 500, {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred processing your request',
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
    const { accessToken, refreshToken } = await issueSessionTokens(user);

    // 5. Set cookie & return response
    setRefreshTokenCookie(res, refreshToken);

    return sendSuccess(res, 200, {
      user: serializeUser(user),
      accessToken,
      refreshToken,
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
    const refreshToken =
      req.cookies?.refreshToken ||
      req.body?.refreshToken ||
      (req.headers['x-refresh-token'] as string);

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

    // 3. Check the session behind this token is still alive. Tokens minted before
    //    per-session revocation existed carry no `jti`; rather than force-logging
    //    those users out, adopt them into a fresh session on this refresh. Every
    //    such token expires by itself 60 days after that change shipped, after
    //    which this branch can be deleted and a missing jti simply rejected.
    if (!payload.jti) {
      const { accessToken, refreshToken: upgradedToken } = await issueSessionTokens(user);
      setRefreshTokenCookie(res, upgradedToken);
      return sendSuccess(res, 200, {
        accessToken,
        refreshToken: upgradedToken,
      }, 'Token refreshed successfully');
    }

    const [session] = await db
      .select()
      .from(refreshSessions)
      .where(and(eq(refreshSessions.id, payload.jti), eq(refreshSessions.userId, user.id)))
      .limit(1);

    if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
      return sendError(res, 401, {
        code: 'UNAUTHORIZED',
        message: 'Refresh token has been revoked',
      });
    }

    // 4. Rotate the token string, keeping the same session. Reusing the jti means
    //    two concurrent refreshes from one session both stay valid instead of one
    //    invalidating the other and bouncing the user to the login screen.
    const newAccessToken = generateAccessToken({ userId: user.id, email: user.email });
    const newRefreshToken = generateRefreshToken({ userId: user.id, email: user.email, jti: session.id });

    setRefreshTokenCookie(res, newRefreshToken);

    return sendSuccess(res, 200, {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
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
router.post('/auth/logout', async (req, res) => {
  const isProd = process.env.NODE_ENV === 'production';
  res.clearCookie('refreshToken', {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
  });

  // Best-effort: revoke just this device's session server-side, so its refresh
  // token stops working instead of staying valid for its full 60-day lifetime.
  // The user's other devices keep their own sessions. Never block the logout
  // response on this — an invalid/missing cookie just means nothing to revoke.
  const refreshToken =
    req.cookies?.refreshToken ||
    req.body?.refreshToken ||
    (req.headers['x-refresh-token'] as string);
  if (refreshToken) {
    try {
      const payload = verifyRefreshToken(refreshToken);
      if (payload.jti) {
        await db
          .update(refreshSessions)
          .set({ revokedAt: new Date() })
          .where(and(eq(refreshSessions.id, payload.jti), eq(refreshSessions.userId, payload.userId)));
      }
    } catch {
      // Invalid/expired token — nothing to revoke, logout still succeeds.
    }
  }

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

    return sendSuccess(res, 200, {
      user: serializeUser(user),
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

    const { name, businessName, phone, occupation, password, currentPassword, preferredCurrency, firstLogin } = req.body;

    // Validation
    const fields: Record<string, string> = {};
    if (name !== undefined && (!name || typeof name !== 'string' || !name.trim())) {
      fields.name = 'Name cannot be empty';
    }
    if (phone !== undefined && phone !== null && typeof phone !== 'string') {
      fields.phone = 'Phone must be a string';
    }
    // Free text, not an enum — the frontend Combobox offers suggestions
    // (shoots-app/src/lib/occupations.ts) but the user can type anything.
    // Mandatory like `name`: null/empty isn't accepted as a way to clear it.
    if (occupation !== undefined && (!occupation || typeof occupation !== 'string' || !occupation.trim())) {
      fields.occupation = 'Occupation cannot be empty';
    }
    if (password !== undefined && password !== null && (typeof password !== 'string' || password.length < 8)) {
      fields.password = 'Password must be at least 8 characters';
    }
    const VALID_CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'AED', 'SGD', 'JPY', 'AUD', 'CAD', 'CHF', 'HKD', 'MYR', 'THB', 'NZD'];
    if (preferredCurrency !== undefined && !VALID_CURRENCIES.includes(preferredCurrency)) {
      fields.preferredCurrency = 'Invalid currency code';
    }
    if (firstLogin !== undefined && typeof firstLogin !== 'boolean') {
      fields.firstLogin = 'firstLogin must be a boolean';
    }

    if (Object.keys(fields).length > 0) {
      return sendError(res, 400, {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        fields,
      });
    }

    // Prepare update payload
    type UserUpdateData = Partial<Pick<typeof users.$inferInsert, 'name' | 'businessName' | 'phone' | 'occupation' | 'preferredCurrency' | 'passwordHash' | 'firstLogin'>> & { updatedAt: Date };
    const updatePayload: UserUpdateData = {
      updatedAt: new Date(),
    };
    if (name !== undefined) updatePayload.name = name.trim();
    if (businessName !== undefined) updatePayload.businessName = businessName?.trim() || null;
    if (phone !== undefined) updatePayload.phone = phone?.trim() || null;
    if (occupation !== undefined) updatePayload.occupation = occupation.trim();
    if (preferredCurrency !== undefined) updatePayload.preferredCurrency = preferredCurrency;
    // Stored as smallint in the DB — see schema.ts — inverted: API `true`
    // ("onboarding complete") writes 0, API `false` writes 1. See the
    // serializeUser() comment above for why the column's own default forces
    // this inversion. The 0/1 encoding never leaves this file.
    if (firstLogin !== undefined) updatePayload.firstLogin = firstLogin ? 0 : 1;

    if (password !== undefined && password !== null) {
      const [existing] = await db
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      if (!existing) {
        return sendError(res, 404, {
          code: 'NOT_FOUND',
          message: 'User not found',
        });
      }

      // Only demand the current password when the account already has one.
      // A hijacked session (stolen access token, XSS, etc.) can otherwise set
      // a brand new password with no proof of the old one, silently locking
      // the real owner out. Accounts that never had a password (e.g. crew
      // members created via invite) are setting one for the first time, so
      // there's nothing to verify against yet.
      if (existing.passwordHash) {
        if (!currentPassword || typeof currentPassword !== 'string') {
          return sendError(res, 400, {
            code: 'VALIDATION_ERROR',
            message: 'Validation failed',
            fields: { currentPassword: 'Current password is required to set a new password' },
          });
        }
        const isMatch = await comparePassword(currentPassword, existing.passwordHash);
        if (!isMatch) {
          return sendError(res, 400, {
            code: 'VALIDATION_ERROR',
            message: 'Validation failed',
            fields: { currentPassword: 'Current password is incorrect' },
          });
        }
      }

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

    // A password change signs out every device, including this one — otherwise a
    // session hijacked before the change keeps working. The settings page signs
    // the user out itself so this isn't a surprise mid-session.
    if (updatePayload.passwordHash) {
      await revokeAllSessions(userId);
    }

    return sendSuccess(res, 200, {
      user: serializeUser(updatedUser),
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
      .select({ email: users.email, passwordHash: users.passwordHash })
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

    // Lets the frontend tell a first-time "set your password" (signup / invite
    // claim) apart from a genuine reset of an existing password, and adjust
    // its copy and post-submit flow (auto sign-in vs. "go log in") accordingly.
    return sendSuccess(
      res,
      200,
      { valid: true, email: user.email, hadPassword: !!user.passwordHash },
      'Reset token is valid.'
    );
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

    // NOTE: deliberately reveals whether an account exists for this email —
    // requested explicitly, aware this trades away the standard anti-
    // enumeration protection (a generic response regardless of match) that
    // this endpoint used to have. Anyone can now probe arbitrary addresses
    // here to learn which ones have accounts on the platform.
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
      console.error(`Forgot password: failed to send reset email to ${cleanEmail}`);
    }

    return sendSuccess(res, 200, {}, 'A password reset link has been sent to your email.');
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

    // Whoever reset the password now owns the account — drop every session that
    // existed beforehand, since this is the flow used to recover a compromised one.
    await revokeAllSessions(user.id);

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
