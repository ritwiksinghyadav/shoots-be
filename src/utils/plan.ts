import { eq, sql } from 'drizzle-orm';
import { Response } from 'express';
import { db } from '../db/index.js';
import { users, projects, appSettings } from '../db/schema.js';
import { sendError } from './response.js';

/**
 * Plan gates. An account is Pro if an admin set `users.isPro`, or if it was
 * created during early access (see below) — there is no checkout yet. Every
 * limit below is enforced here, on the server, because the frontend copy is
 * only a hint: a crafted request must not be able to buy itself Pro behaviour.
 */

/** Total shoots a Free account may create, in any status. */
export const FREE_SHOOT_LIMIT = 3;

/** How far back Free accounts can see their own money. */
export const FREE_ANALYTICS_MONTHS = 12;

/**
 * Early access keeps its promise: "join now, keep Pro free when paid plans
 * start". Every account created before the end date is Pro for good, with no
 * data migration needed. No date means early access is still running, so
 * every account is Pro. Admins set the date from the admin panel; it lives in
 * `app_settings` under this key as an ISO timestamp.
 */
export const EARLY_ACCESS_KEY = 'early_access_ends_at';

// Plan checks run on most requests; the setting changes a few times a year.
// A short cache keeps it off the hot path, and the admin write clears it.
const CACHE_TTL_MS = 30_000;
// The promise is cached, not the value, so concurrent requests on a cold
// cache share one query instead of each firing their own.
let cached: { value: Promise<Date | null>; at: number } | null = null;

export function clearEarlyAccessCache() {
  cached = null;
}

export function getEarlyAccessEnd(): Promise<Date | null> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  const value = readEarlyAccessEnd();
  cached = { value, at: Date.now() };
  // Don't pin a failed read for the whole TTL.
  value.catch(() => {
    if (cached?.value === value) cached = null;
  });
  return value;
}

async function readEarlyAccessEnd(): Promise<Date | null> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, EARLY_ACCESS_KEY))
    .limit(1);
  const d = row?.value ? new Date(row.value) : null;
  // The admin route validates on write, so an unparseable value means the row
  // was edited by hand — treat it as "still open" rather than revoke Pro.
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

export async function isEarlyAccessOpen(now = new Date()): Promise<boolean> {
  const end = await getEarlyAccessEnd();
  return !end || now < end;
}

type PlanUser = { isPro: boolean; createdAt: Date };

/** Pro only because the account joined during early access (not admin-granted). */
export function isEarlyAccessPro(user: PlanUser, end: Date | null): boolean {
  return !user.isPro && (!end || user.createdAt < end);
}

/** The one place that decides whether an account gets Pro. */
export async function hasPro(user: PlanUser): Promise<boolean> {
  return user.isPro || isEarlyAccessPro(user, await getEarlyAccessEnd());
}

export async function isProUser(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ isPro: users.isPro, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ? hasPro(row) : false;
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
