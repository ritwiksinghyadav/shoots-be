import { and, eq, isNull, sql } from 'drizzle-orm';
import { Response } from 'express';
import { db } from '../db/index.js';
import { users, projects, appSettings } from '../db/schema.js';
import { sendError } from './response.js';

/**
 * Plan gates. Every limit below is enforced here, on the server, because the
 * frontend copy is only a hint: a crafted request must not be able to buy
 * itself Pro behaviour. See docs/PLANS.md for the full model.
 *
 * Pro is always a dated term, never permanent. An account is Pro while at
 * least one of these is still running, and the one that ends last wins:
 *   - admin          users.isPro, valid until users.proUntil (granted from the admin panel)
 *   - early_access   TERM_MONTHS.early_access from activation, if activated before early access ended
 *   - (subscription) a paid Razorpay period, once billing is built
 * When none is running, the account is on Free.
 */

/** Total shoots a Free account may create, in any status. */
export const FREE_SHOOT_LIMIT = 3;

/** How far back Free accounts can see their own money. */
export const FREE_ANALYTICS_MONTHS = 12;

/**
 * Length of each kind of Pro term, in months. Free terms (early bird, admin
 * grant) are short; a paid term is the full year that ₹799 buys.
 */
export const TERM_MONTHS = {
  early_access: 6,
  admin: 6,
  subscription: 12,
} as const;

/** `from` plus a number of calendar months (UTC). */
export function addMonths(from: Date, months: number): Date {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

/**
 * Early access: every account *activated* before the end date gets its first
 * TERM_MONTHS.early_access of Pro free, counted from the day it activated. After that
 * it drops to Free until it pays. Activation, not row creation, is what counts: a crew invite creates the row
 * long before the person ever signs in, and that must not lock in Pro for them.
 * No date means early access is still running. Admins set the date from the
 * admin panel; it lives in `app_settings` under this key as an ISO timestamp.
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

export type PlanUser = { isPro: boolean; proUntil: Date | null; activatedAt: Date | null };

export type PlanTier = 'free' | 'pro';
/** Where a Pro term comes from. `null` means plain Free. */
export type PlanSource = 'admin' | 'early_access' | null;

export interface Plan {
  tier: PlanTier;
  /** The running term that ends last, or null on Free. */
  source: PlanSource;
  /** When the current Pro term ends. Null on Free. */
  proUntil: Date | null;
  /**
   * On Free after a Pro term ran out: which one, and when. Lets the app say
   * "your free early-bird Pro ended on …" instead of a generic upgrade prompt.
   */
  lapsed: { source: Exclude<PlanSource, null>; endedAt: Date } | null;
}

/**
 * The early-bird term, if the account qualifies: activated while early access
 * was open. Never-activated rows (an invited crew member who hasn't signed in
 * yet) don't qualify until they activate. Returns the term's end date, whether
 * or not it has passed.
 */
export function earlyBirdUntil(user: PlanUser, end: Date | null): Date | null {
  if (!user.activatedAt) return null;
  if (end && user.activatedAt >= end) return null;
  return addMonths(user.activatedAt, TERM_MONTHS.early_access);
}

/** True while the early-bird term is running and no other term outlasts it. */
export function isEarlyAccessPro(user: PlanUser, end: Date | null, now = new Date()): boolean {
  return resolvePlan(user, end, now).source === 'early_access';
}

// Stand-in end for an admin grant made before grants carried a date. The
// backfill script dates them; until then they keep running, reported as null.
const UNDATED = new Date(8.64e15);

/** Pure plan resolution, for callers that already hold the end date (lists). */
export function resolvePlan(user: PlanUser, end: Date | null, now = new Date()): Plan {
  const terms: { source: Exclude<PlanSource, null>; until: Date }[] = [];
  if (user.isPro) terms.push({ source: 'admin', until: user.proUntil ?? UNDATED });
  const earlyBird = earlyBirdUntil(user, end);
  if (earlyBird) terms.push({ source: 'early_access', until: earlyBird });

  const running = terms.filter((t) => t.until > now).sort((a, b) => b.until.getTime() - a.until.getTime());
  if (running.length) {
    const t = running[0];
    return { tier: 'pro', source: t.source, proUntil: t.until === UNDATED ? null : t.until, lapsed: null };
  }

  const ended = terms.sort((a, b) => b.until.getTime() - a.until.getTime())[0];
  return { tier: 'free', source: null, proUntil: null, lapsed: ended ? { source: ended.source, endedAt: ended.until } : null };
}

/** The one place that decides which plan an account is on. */
export async function getPlan(user: PlanUser): Promise<Plan> {
  return resolvePlan(user, await getEarlyAccessEnd());
}

export async function hasPro(user: PlanUser): Promise<boolean> {
  return (await getPlan(user)).tier === 'pro';
}

export async function isProUser(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ isPro: users.isPro, proUntil: users.proUntil, activatedAt: users.activatedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ? hasPro(row) : false;
}

/**
 * Stamps `activatedAt` the first time an account becomes usable. Safe to call
 * on every password set or sign-in: it never moves an existing date, so a
 * later password reset can't restart an early-bird term.
 */
export async function markActivated(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ activatedAt: new Date() })
    .where(and(eq(users.id, userId), isNull(users.activatedAt)));
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
