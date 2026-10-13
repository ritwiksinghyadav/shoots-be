import { Request } from 'express';
import { rateLimit, ipKeyGenerator, MINUTE, HOUR, DAY } from 'express-rate-limit';
import { AuthenticatedRequest } from './auth.js';

/**
 * Abuse limits. In-memory, which is right for the single Render instance this
 * runs on; move to a shared store (Redis) before running more than one.
 * Requires `app.set('trust proxy', 1)` so `req.ip` is the client, not Render's
 * proxy. Responses use the app's standard error envelope.
 */

function limitedBy(message: string) {
  return {
    standardHeaders: 'draft-8' as const,
    legacyHeaders: false,
    statusCode: 429,
    message: { success: false, error: { code: 'RATE_LIMITED', message }, statusCode: 429 },
  };
}

const ip = (req: Request) => ipKeyGenerator(req.ip ?? 'unknown');
const emailOf = (req: Request) =>
  typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';

/** Password guessing: per IP and per account, so neither one IP nor many IPs can grind one account. */
export const loginByIp = rateLimit({
  windowMs: 15 * MINUTE,
  limit: 30,
  keyGenerator: ip,
  ...limitedBy('Too many sign-in attempts. Please wait 15 minutes and try again.'),
});

export const loginByEmail = rateLimit({
  windowMs: 15 * MINUTE,
  limit: 10,
  keyGenerator: (req) => `login:${emailOf(req)}`,
  skip: (req) => !emailOf(req),
  ...limitedBy('Too many sign-in attempts for this account. Please wait 15 minutes and try again.'),
});

/** Anything that sends an email to an address typed into a form (signup, forgot password). */
export const emailSendByIp = rateLimit({
  windowMs: HOUR,
  limit: 20,
  keyGenerator: ip,
  ...limitedBy('Too many requests. Please try again in an hour.'),
});

export const emailSendByAddress = rateLimit({
  windowMs: HOUR,
  limit: 5,
  keyGenerator: (req) => `mail:${emailOf(req)}`,
  skip: (req) => !emailOf(req),
  ...limitedBy('We have already sent several emails to this address. Please check your inbox, or try again in an hour.'),
});

/** Token checks on the reset page, so reset links can't be guessed by brute force. */
export const tokenCheckByIp = rateLimit({
  windowMs: 15 * MINUTE,
  limit: 60,
  keyGenerator: ip,
  ...limitedBy('Too many attempts. Please wait a few minutes and try again.'),
});

/**
 * Crew invites send email to arbitrary addresses, so they're capped per
 * account. Counted per request; the members route also caps emails per request.
 */
export const invitesByAccount = rateLimit({
  windowMs: DAY,
  limit: 100,
  keyGenerator: (req) => `invite:${(req as AuthenticatedRequest).user?.userId ?? ip(req)}`,
  ...limitedBy('You have added a lot of crew today. Please try again tomorrow, or contact support.'),
});
