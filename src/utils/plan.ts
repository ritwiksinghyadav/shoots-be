import { eq, sql } from 'drizzle-orm';
import { Response } from 'express';
import { db } from '../db/index.js';
import { users, projects } from '../db/schema.js';
import { sendError } from './response.js';

/**
 * Plan gates. `users.isPro` is the single source of truth and is admin-toggled
 * today — there is no checkout yet. Every limit below is enforced here, on the
 * server, because the frontend copy is only a hint: a crafted request must not
 * be able to buy itself Studio behaviour.
 */

/** Total shoots a Free account may create, in any status. */
export const FREE_SHOOT_LIMIT = 3;

/** How far back Free accounts can see their own money. */
export const FREE_ANALYTICS_MONTHS = 12;

export async function isProUser(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ isPro: users.isPro })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.isPro ?? false;
}

/** Every shoot the user owns, whatever its status — the cap is on creation. */
export async function countOwnedProjects(userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(projects)
    .where(eq(projects.ownerId, userId));
  return Number(row?.count ?? 0);
}

/**
 * 402 rather than 403: the request is well-formed and the caller is who they
 * say they are — the only thing missing is a plan. The frontend keys its
 * upgrade prompt off this code.
 */
export function sendProRequired(res: Response, message: string) {
  return sendError(res, 402, { code: 'PRO_REQUIRED', message });
}

/** The earliest YYYY-MM a Free account may see, inclusive. */
export function freeAnalyticsCutoffMonth(): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - (FREE_ANALYTICS_MONTHS - 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
