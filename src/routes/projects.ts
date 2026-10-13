import { Router, Response } from 'express';
import crypto from 'crypto';
import { eq, and, or, asc, desc, inArray, ne, gte, lte, like, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { db } from '../db/index.js';
import { projects, shootDays, shootMembers, expenses, users, teamMembers, shootMilestones, clientPayments, crewPayouts } from '../db/schema.js';
import {
  memberChange,
  recomputeMember,
  recomputeProject,
  shapeClientPayment,
  shapePayout,
  validatePaymentEntry,
} from '../utils/money.js';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { sendSuccess, sendError } from '../utils/response.js';
import { sendInvitationEmail } from '../utils/email.js';
import { invitesByAccount } from '../middleware/rateLimit.js';
import {
  MONEY_MESSAGE,
  isDateString,
  isOptionalText,
  isPaymentStatus,
  parseLimit,
  parseMoney,
  parsePage,
  validateShootDay,
  type ShootDayValue,
} from '../utils/validate.js';
import {
  isProUser,
  countOwnedProjects,
  sendProRequired,
  freeAnalyticsCutoffMonth,
  FREE_SHOOT_LIMIT,
  FREE_ANALYTICS_MONTHS,
} from '../utils/plan.js';

const router = Router();

/** The business pipeline. `projects.status` is free text in the DB; the API keeps it to these. */
const PROJECT_STATUSES = ['inquiry', 'booked', 'paid'];
const EXPENSE_CATEGORIES = ['equipment', 'travel', 'food', 'props', 'venue', 'misc'];
const MAX_SHOOT_DAYS = 60;
/** Crew emails per request; the per-account daily cap is in middleware/rateLimit.ts. */
const MAX_INVITES_PER_REQUEST = 20;

/** Title/client/notes/icon checks shared by create, update and the bulk edit route. */
function validateProjectFields(body: Record<string, unknown>, { partial }: { partial: boolean }) {
  const fields: Record<string, string> = {};
  const { title, client, status, budget, icon, notes, productionStage } = body;
  const need = (v: unknown) => !partial || v !== undefined;

  if (need(title) && (typeof title !== 'string' || !title.trim() || title.length > 200)) fields.title = 'Title is required (up to 200 characters)';
  if (need(client) && (typeof client !== 'string' || !client.trim() || client.length > 200)) fields.client = 'Client name is required (up to 200 characters)';
  if (need(budget) && parseMoney(budget) === null) fields.budget = MONEY_MESSAGE;
  if (status !== undefined && status !== '' && !PROJECT_STATUSES.includes(status as string)) fields.status = 'Status must be inquiry, booked or paid';
  if (!isOptionalText(icon, 16)) fields.icon = 'Icon is invalid';
  if (!isOptionalText(notes)) fields.notes = 'Notes must be text up to 5000 characters';
  if (productionStage !== undefined && (typeof productionStage !== 'string' || !productionStage.trim() || productionStage.length > 50)) {
    fields.productionStage = 'Stage cannot be empty';
  }
  return fields;
}

/** Column values for a project update, from an already-validated body. */
function projectUpdateValues(body: Record<string, unknown>) {
  const { title, client, status, budget, icon, notes, productionStage } = body;
  return {
    ...(title !== undefined && { title: (title as string).trim() }),
    ...(client !== undefined && { client: (client as string).trim() }),
    ...(status !== undefined && status !== '' && { status: status as string }),
    ...(budget !== undefined && { budget: parseMoney(budget)! }),
    ...(icon !== undefined && { icon: (icon as string | null) || null }),
    ...(notes !== undefined && { notes: typeof notes === 'string' ? notes.trim() : null }),
    ...(productionStage !== undefined && { productionStage: (productionStage as string).trim() }),
  };
}

function validateExpense(body: Record<string, unknown>, prefix = '') {
  const fields: Record<string, string> = {};
  const { label, amount, category, date } = body;
  if (typeof label !== 'string' || !label.trim() || label.length > 200) fields[`${prefix}label`] = 'Label is required (up to 200 characters)';
  if (parseMoney(amount, { allowZero: false }) === null) fields[`${prefix}amount`] = 'Enter a whole amount greater than 0';
  if (category !== undefined && category !== null && category !== '' && !EXPENSE_CATEGORIES.includes(category as string)) fields[`${prefix}category`] = 'Invalid category';
  if (date !== undefined && date !== null && date !== '' && !isDateString(date)) fields[`${prefix}date`] = 'Date must be YYYY-MM-DD';
  return fields;
}

function expenseValues(projectId: string, body: Record<string, unknown>) {
  return {
    projectId,
    label: (body.label as string).trim(),
    amount: parseMoney(body.amount, { allowZero: false })!,
    category: (body.category as string) || 'misc',
    date: isDateString(body.date) ? body.date : null,
  };
}

function validateMilestone(body: Record<string, unknown>, prefix = '') {
  const fields: Record<string, string> = {};
  const { stage, note, date } = body;
  if (typeof stage !== 'string' || !stage.trim() || stage.length > 50) fields[`${prefix}stage`] = 'Stage is required';
  if (!isDateString(date)) fields[`${prefix}date`] = 'Date must be YYYY-MM-DD';
  if (typeof note !== 'string' || !note.trim() || note.length > 1000) fields[`${prefix}note`] = 'Note is required (up to 1000 characters)';
  return fields;
}

/** Fee / paid / invited for a crew row. `invited` must be a real boolean. */
function validateMemberFields(body: Record<string, unknown>, prefix = '') {
  const fields: Record<string, string> = {};
  if (body.payment !== undefined && parseMoney(body.payment) === null) fields[`${prefix}payment`] = MONEY_MESSAGE;
  if (body.paymentStatus !== undefined && !isPaymentStatus(body.paymentStatus)) fields[`${prefix}paymentStatus`] = 'Payment status must be paid or unpaid';
  if (body.invited !== undefined && typeof body.invited !== 'boolean') fields[`${prefix}invited`] = 'invited must be true or false';
  return fields;
}

function validationError(res: Response, fields: Record<string, string>) {
  return sendError(res, 400, { code: 'VALIDATION_ERROR', message: 'Validation failed', fields });
}

/** A stable, URL-safe opaque token for the public share link. */
function generateShareToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function shapeMilestone(m: typeof shootMilestones.$inferSelect) {
  return {
    id: m.id,
    stage: m.stage,
    note: m.note ?? undefined,
    date: m.date ?? undefined,
    createdAt: m.createdAt.toISOString(),
  };
}

// ─── Shape helpers ──────────────────────────────────────────────────────────

function shapeShootDay(d: typeof shootDays.$inferSelect) {
  return {
    id: d.id,
    date: d.date,
    time: d.time,
    location: d.locationJSON as { name: string; mapsUrl?: string },
    notes: d.eventTitle ?? undefined,
  };
}

const AVATAR_COLORS = [
  '#7C3AED', // Violet
  '#0284C7', // Sky
  '#059669', // Emerald
  '#DB2777', // Pink
  '#EA580C', // Orange
  '#2563EB', // Blue
  '#D97706', // Amber
  '#4F46E5', // Indigo
];

function getAvatarColor(email: string) {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = email.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % AVATAR_COLORS.length;
  return AVATAR_COLORS[index];
}

function getInitials(nameOrEmail: string) {
  const clean = nameOrEmail.split('@')[0].trim();
  const parts = clean.split(/[\s._-]+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}

function shapeProject(
  p: typeof projects.$inferSelect,
  ownerName: string,
  ownerEmail: string,
  days: (typeof shootDays.$inferSelect)[],
  exps: (typeof expenses.$inferSelect)[] = [],
  team: TeamMemberInput[] = [],
  milestones: (typeof shootMilestones.$inferSelect)[] = [],
  payments: (typeof clientPayments.$inferSelect)[] = []
) {
  return {
    id: p.id,
    ownerId: p.ownerId,
    ownerName,
    ownerEmail,
    title: p.title,
    client: p.client,
    status: p.status,
    budget: p.budget,
    /** Money in from the client so far; the rest of the budget is still due. */
    amountReceived: p.amountReceived,
    clientPayments: payments
      .slice()
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.getTime() - a.createdAt.getTime())
      .map(shapeClientPayment),
    emoji: p.icon ?? '📸',
    notes: p.notes ?? '',
    category: 'editorial' as const,
    coverColor: '#7C3AED',
    team: team.map(shapeTeamMember),
    expenses: exps.map((e) => ({
      id: e.id,
      label: e.label,
      amount: e.amount,
      category: (e.category ?? 'misc') as 'equipment' | 'travel' | 'food' | 'props' | 'venue' | 'misc',
      date: e.date ?? undefined,
    })),
    shootDays: days.map(shapeShootDay),
    productionStage: p.productionStage,
    milestones: milestones
      .slice()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(shapeMilestone),
    shareEnabled: p.shareEnabled,
    shareToken: p.shareToken ?? null,
  };
}

/**
 * Mask budget and other members' payment info for a non-owner viewer.
 * Same invariant as stripProjectForMember(), for call sites that build a
 * lighter-weight shoot shape (calendar/upcoming-days) instead of the full
 * shapeProject() output.
 */
function maskFinancialsForViewer<
  T extends { userId: string | null; payment: number; amountPaid: number; paymentStatus: MemberPaymentStatus }
>(isOwner: boolean, userId: string, budget: number, team: T[]): { budget: number; team: T[] } {
  if (isOwner) return { budget, team };
  return {
    budget: 0,
    team: team.map((member) =>
      member.userId === userId ? member : { ...member, payment: 0, amountPaid: 0, paymentStatus: 'unpaid' as const, payouts: [] }
    ),
  };
}

/** Strip confidential financial and expense details from a project for a crew member */
function stripProjectForMember(project: ReturnType<typeof shapeProject>, userId: string) {
  return {
    ...project,
    budget: 0,
    amountReceived: 0,
    clientPayments: [],
    expenses: [],
    // Sharing is an owner-only control — crew see the timeline but not the link/token.
    shareToken: null,
    team: project.team.map((member) => {
      // Keep own payment details, mask other crew members' financial details
      if (member.userId === userId) {
        return member;
      }
      return {
        ...member,
        payment: 0,
        amountPaid: 0,
        paymentStatus: 'unpaid' as const,
        payouts: [],
      };
    }),
  };
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

/** Verify the user owns the project and return it, or send a 403/404. */
async function requireProjectOwner(
  projectId: string,
  userId: string,
  res: Response
): Promise<typeof projects.$inferSelect | undefined> {
  // 1. Fetch project by ID (without ownerId filtering first to check existence)
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) {
    sendError(res, 404, { code: 'NOT_FOUND', message: 'Project not found' });
    return undefined;
  }

  // 2. Check if user is the owner
  if (project.ownerId === userId) {
    return project;
  }

  // 3. Check if user is a member of the project
  const [isMember] = await db
    .select()
    .from(shootMembers)
    .where(and(eq(shootMembers.projectId, projectId), eq(shootMembers.userId, userId)))
    .limit(1);

  if (isMember) {
    sendError(res, 403, { code: 'FORBIDDEN', message: 'You do not have permission to mutate this project' });
  } else {
    sendError(res, 404, { code: 'NOT_FOUND', message: 'Project not found' });
  }
  return undefined;
}

type MemberPaymentStatus = 'paid' | 'partial' | 'unpaid';

interface TeamMemberInput {
  id: string;
  userId: string | null;
  name: string | null;
  email: string | null;
  payment: number;
  amountPaid: number;
  paymentStatus: string;
  invited: boolean;
  /** Only on the single-shoot endpoint; lists carry the total, not the rows. */
  payouts?: (typeof crewPayouts.$inferSelect)[];
}

/** Shape a shoot member row (with optional joined user fields) into the API shape. */
function shapeTeamMember(t: TeamMemberInput) {
  const email = t.email ?? '';
  const name = t.name || null;
  return {
    id: t.id,
    userId: t.userId,
    name,
    email,
    initials: getInitials(name || email),
    payment: t.payment,
    amountPaid: t.amountPaid,
    paymentStatus: (['paid', 'partial'].includes(t.paymentStatus) ? t.paymentStatus : 'unpaid') as MemberPaymentStatus,
    payouts: (t.payouts ?? [])
      .slice()
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.getTime() - a.createdAt.getTime())
      .map(shapePayout),
    invited: t.invited,
    avatarColor: getAvatarColor(email),
  };
}

// Apply auth middleware to all project routes
router.use(['/projects', '/search', '/team-members'], requireAuth);

// Every id in these paths is a uuid column; anything else can't exist.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
for (const param of ['id', 'projectId', 'dayId', 'expenseId', 'milestoneId', 'memberId', 'paymentId', 'payoutId']) {
  router.param(param, (_req, res, next, value) => {
    if (!isUuid(value)) return sendError(res, 404, { code: 'NOT_FOUND', message: 'Not found' });
    next();
  });
}

// GET /search?q= — unified search across shoots, crew (circle), and clients.
// One bundled endpoint (rather than three client-side calls) so the frontend
// can fetch it as a single Server Action, matching the app's established
// "one bundled read per page" pattern.
router.get('/search', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    if (!q) {
      return sendSuccess(res, 200, { shoots: [], crew: [], clients: [] }, 'Empty query');
    }
    const pattern = `%${q}%`;

    // Shoots the user owns or is a crew member on, matching title or client.
    const shootRows = await db
      .select({ project: projects })
      .from(projects)
      .leftJoin(shootMembers, and(eq(projects.id, shootMembers.projectId), eq(shootMembers.userId, userId)))
      .where(
        and(
          or(eq(projects.ownerId, userId), eq(shootMembers.userId, userId)),
          or(
            like(sql`lower(${projects.title})`, pattern),
            like(sql`lower(${projects.client})`, pattern)
          )
        )
      )
      .groupBy(projects.id)
      .limit(6);

    // Crew — this user's own circle (team_members), matching name or email.
    const crewRows = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(teamMembers)
      .innerJoin(users, eq(teamMembers.memberId, users.id))
      .where(
        and(
          eq(teamMembers.userId, userId),
          or(
            like(sql`lower(${users.name})`, pattern),
            like(sql`lower(${users.email})`, pattern)
          )
        )
      )
      .limit(6);

    // Clients — distinct client names on accessible projects matching the query.
    const clientRows = await db
      .select({ client: projects.client })
      .from(projects)
      .leftJoin(shootMembers, and(eq(projects.id, shootMembers.projectId), eq(shootMembers.userId, userId)))
      .where(
        and(
          or(eq(projects.ownerId, userId), eq(shootMembers.userId, userId)),
          like(sql`lower(${projects.client})`, pattern)
        )
      )
      .groupBy(projects.client)
      .limit(20);

    const uniqueClients = Array.from(new Set(clientRows.map((r) => r.client))).slice(0, 6);

    return sendSuccess(
      res,
      200,
      {
        shoots: shootRows.map((r) => ({
          id: r.project.id,
          title: r.project.title,
          client: r.project.client,
          emoji: r.project.icon ?? '📸',
          status: r.project.status,
        })),
        crew: crewRows.map((r) => ({
          id: r.id,
          name: r.name || r.email,
          email: r.email,
          initials: getInitials(r.name || r.email),
          avatarColor: getAvatarColor(r.email),
        })),
        clients: uniqueClients,
      },
      'Search results fetched successfully'
    );
  } catch (error) {
    console.error('Error performing global search:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to perform search' });
  }
});

// GET /projects/upcoming-days — fetch shoot days between today and one month from today
router.get('/projects/upcoming-days', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];

    const oneMonthLater = new Date();
    oneMonthLater.setMonth(oneMonthLater.getMonth() + 1);
    const oneMonthLaterStr = oneMonthLater.toISOString().split('T')[0];

    const rows = await db
      .select({
        shootDay: shootDays,
        project: projects,
        ownerName: users.name,
        ownerEmail: users.email,
      })
      .from(shootDays)
      .innerJoin(projects, eq(shootDays.projectId, projects.id))
      .innerJoin(users, eq(projects.ownerId, users.id))
      .leftJoin(shootMembers, and(eq(projects.id, shootMembers.projectId), eq(shootMembers.userId, userId)))
      .where(
        and(
          or(
            eq(projects.ownerId, userId),
            eq(shootMembers.userId, userId)
          ),
          gte(shootDays.date, todayStr),
          lte(shootDays.date, oneMonthLaterStr),
          ne(projects.status, 'paid')
        )
      )
      .orderBy(asc(shootDays.date), asc(shootDays.time));

    const projectIds = Array.from(new Set(rows.map((r) => r.project.id)));

    // Fetch all shoot members for those projects in one query
    const allMembers = projectIds.length > 0 ? await db
      .select({
        id: shootMembers.id,
        projectId: shootMembers.projectId,
        userId: shootMembers.userId,
        name: users.name,
        email: users.email,
        payment: shootMembers.payment,
        amountPaid: shootMembers.amountPaid,
        paymentStatus: shootMembers.paymentStatus,
        invited: shootMembers.invited,
      })
      .from(shootMembers)
      .leftJoin(users, eq(shootMembers.userId, users.id))
      .where(inArray(shootMembers.projectId, projectIds)) : [];

    // Group members by project
    const membersByProject = new Map<string, typeof allMembers>();
    for (const m of allMembers) {
      if (!membersByProject.has(m.projectId)) membersByProject.set(m.projectId, []);
      membersByProject.get(m.projectId)!.push(m);
    }

    const result = rows.map((row) => {
      const shapedDay = shapeShootDay(row.shootDay);
      const projectMembers = membersByProject.get(row.project.id) ?? [];
      const isOwner = row.project.ownerId === userId;
      const { budget, team } = maskFinancialsForViewer(
        isOwner,
        userId,
        row.project.budget,
        projectMembers.map(shapeTeamMember)
      );
      return {
        shoot: {
          id: row.project.id,
          ownerId: row.project.ownerId,
          ownerName: row.ownerName || row.ownerEmail || row.project.ownerId,
          title: row.project.title,
          client: row.project.client,
          status: row.project.status,
          budget,
          emoji: row.project.icon ?? '📸',
          notes: row.project.notes ?? '',
          category: 'editorial',
          coverColor: '#7C3AED',
          team,
          expenses: [],
          shootDays: [shapedDay],
        },
        shootDay: shapedDay,
      };
    });

    return sendSuccess(res, 200, { shootDays: result }, 'Upcoming shoot days fetched successfully');
  } catch (error) {
    console.error('Error fetching upcoming shoot days:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to fetch upcoming shoot days' });
  }
});

// GET /projects/shoot-days — fetch shoot days for a specific year and month (0-indexed)
router.get('/projects/shoot-days', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    const year = parseInt(req.query.year as string, 10);
    const month = parseInt(req.query.month as string, 10); // 0-indexed

    if (isNaN(year) || isNaN(month)) {
      return sendError(res, 400, { code: 'BAD_REQUEST', message: 'Year and month are required query parameters' });
    }

    const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;

    const rows = await db
      .select({
        shootDay: shootDays,
        project: projects,
        ownerName: users.name,
        ownerEmail: users.email,
      })
      .from(shootDays)
      .innerJoin(projects, eq(shootDays.projectId, projects.id))
      .innerJoin(users, eq(projects.ownerId, users.id))
      .leftJoin(shootMembers, and(eq(projects.id, shootMembers.projectId), eq(shootMembers.userId, userId)))
      .where(
        and(
          or(
            eq(projects.ownerId, userId),
            eq(shootMembers.userId, userId)
          ),
          like(shootDays.date, `${prefix}%`)
        )
      )
      .orderBy(asc(shootDays.date), asc(shootDays.time));

    const projectIds = Array.from(new Set(rows.map((r) => r.project.id)));

    // Fetch all shoot members for those projects in one query
    const allMembers = projectIds.length > 0 ? await db
      .select({
        id: shootMembers.id,
        projectId: shootMembers.projectId,
        userId: shootMembers.userId,
        name: users.name,
        email: users.email,
        payment: shootMembers.payment,
        amountPaid: shootMembers.amountPaid,
        paymentStatus: shootMembers.paymentStatus,
        invited: shootMembers.invited,
      })
      .from(shootMembers)
      .leftJoin(users, eq(shootMembers.userId, users.id))
      .where(inArray(shootMembers.projectId, projectIds)) : [];

    // Group members by project
    const membersByProject = new Map<string, typeof allMembers>();
    for (const m of allMembers) {
      if (!membersByProject.has(m.projectId)) membersByProject.set(m.projectId, []);
      membersByProject.get(m.projectId)!.push(m);
    }

    const result = rows.map((row) => {
      const shapedDay = shapeShootDay(row.shootDay);
      const projectMembers = membersByProject.get(row.project.id) ?? [];
      const isOwner = row.project.ownerId === userId;
      const { budget, team } = maskFinancialsForViewer(
        isOwner,
        userId,
        row.project.budget,
        projectMembers.map(shapeTeamMember)
      );
      return {
        shoot: {
          id: row.project.id,
          ownerId: row.project.ownerId,
          ownerName: row.ownerName || row.ownerEmail || row.project.ownerId,
          title: row.project.title,
          client: row.project.client,
          status: row.project.status,
          budget,
          emoji: row.project.icon ?? '📸',
          notes: row.project.notes ?? '',
          category: 'editorial',
          coverColor: '#7C3AED',
          team,
          expenses: [],
          shootDays: [shapedDay],
        },
        shootDay: shapedDay,
      };
    });

    return sendSuccess(res, 200, { shootDays: result }, 'Shoot days fetched successfully');
  } catch (error) {
    console.error('Error fetching shoot days for month:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to fetch shoot days' });
  }
});

// GET /projects/analytics
router.get('/projects/analytics', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    // 1. Fetch owned projects summary: budget, project month, and crew payouts
    // Excludes 'inquiry' projects — an inquiry is an unconfirmed lead (see the
    // "Still in Inquiry — needs confirming" dashboard messaging), not real
    // revenue, so it shouldn't inflate Net Earnings until it's booked/paid.
    const ownedProjectsQuery = await db.execute(sql`
      SELECT
        p.id,
        p.budget,
        COALESCE(
          (SELECT LEFT(MIN(sd.date), 7) FROM shoot_days sd WHERE sd.project_id = p.id),
          TO_CHAR(p.created_at, 'YYYY-MM')
        ) AS project_month,
        COALESCE(
          (SELECT SUM(sm.payment) FROM shoot_members sm WHERE sm.project_id = p.id),
          0
        )::integer AS crew_payouts
      FROM projects p
      WHERE p.owner_id = ${userId}::uuid AND p.status != 'inquiry'
    `);

    // 2. Fetch expenses grouped by month for owned projects (same inquiry
    // exclusion, so a costed-but-unconfirmed lead doesn't drag down profit
    // for revenue it was also excluded from)
    const expensesQuery = await db.execute(sql`
      SELECT
        COALESCE(
          LEFT(e.date, 7),
          TO_CHAR(e.created_at, 'YYYY-MM')
        ) AS expense_month,
        SUM(e.amount)::integer AS total_amount
      FROM expenses e
      JOIN projects p ON e.project_id = p.id
      WHERE p.owner_id = ${userId}::uuid AND p.status != 'inquiry'
      GROUP BY expense_month
    `);

    // 3. Fetch member projects: payment earnings grouped by project month
    // (same inquiry exclusion — a payment on a project you're crew on that's
    // still just an inquiry isn't earned yet either)
    const memberProjectsQuery = await db.execute(sql`
      SELECT
        COALESCE(
          (SELECT LEFT(MIN(sd.date), 7) FROM shoot_days sd WHERE sd.project_id = p.id),
          TO_CHAR(p.created_at, 'YYYY-MM')
        ) AS project_month,
        SUM(sm.payment)::integer AS total_payment
      FROM shoot_members sm
      JOIN projects p ON sm.project_id = p.id
      WHERE sm.user_id = ${userId}::uuid AND p.status != 'inquiry'
      GROUP BY project_month
    `);

    // 4. Fetch crew payouts: aggregated per crew member (users.email is
    // unique, so grouping by user id is the same as grouping by email). The
    // user id lets the frontend link to /circle/[userId] instead of by email.
    const crewPayoutsQuery = await db.execute(sql`
      SELECT 
        u.id AS user_id,
        LOWER(u.email) AS email,
        MAX(u.name) AS name,
        -- Part payments count: paid is what's gone out, owed is the rest of the fee.
        -- A ₹0 fee marked paid by hand has nothing in either column.
        SUM(sm.amount_paid)::integer AS total_paid,
        SUM(GREATEST(sm.payment - sm.amount_paid, 0))::integer AS total_unpaid
      FROM shoot_members sm
      JOIN projects p ON sm.project_id = p.id
      JOIN users u ON sm.user_id = u.id
      WHERE p.owner_id = ${userId}::uuid
      GROUP BY u.id, LOWER(u.email)
    `);

    // 4b. Money still to come in from clients on confirmed (non-inquiry) shoots.
    const receivablesQuery = await db.execute(sql`
      SELECT
        COALESCE(SUM(amount_received), 0)::integer AS received,
        COALESCE(SUM(GREATEST(budget - amount_received, 0)), 0)::integer AS due
      FROM projects
      WHERE owner_id = ${userId}::uuid AND status != 'inquiry'
    `);
    const receivables = (receivablesQuery.rows as unknown as { received: number; due: number }[])[0] ?? { received: 0, due: 0 };

    // 5. Type definitions for raw SQL query results
    interface OwnedProjectRow { project_month: string; budget: number; crew_payouts: number }
    interface ExpenseRow { expense_month: string; total_amount: number }
    interface MemberProjectRow { project_month: string; total_payment: number }
    interface CrewPayoutRow { user_id: string; email: string; name: string; total_paid: number; total_unpaid: number }

    // 6. Aggregate monthly financials
    const monthlyData: Record<string, { revenue: number; expenses: number; crewPayouts: number; profit: number; ownedProfit: number; memberEarnings: number }> = {};

    const getMonthlyRecord = (month: string) => {
      if (!monthlyData[month]) {
        monthlyData[month] = { revenue: 0, expenses: 0, crewPayouts: 0, profit: 0, ownedProfit: 0, memberEarnings: 0 };
      }
      return monthlyData[month];
    };

    // Process owned projects
    for (const row of ownedProjectsQuery.rows as unknown as OwnedProjectRow[]) {
      const month = row.project_month;
      const budget = Number(row.budget || 0);
      const crewPayouts = Number(row.crew_payouts || 0);
      
      const rec = getMonthlyRecord(month);
      rec.revenue += budget;
      rec.crewPayouts += crewPayouts;
      rec.ownedProfit += (budget - crewPayouts);
    }

    // Process expenses
    for (const row of expensesQuery.rows as unknown as ExpenseRow[]) {
      const month = row.expense_month;
      const amount = Number(row.total_amount || 0);
      
      const rec = getMonthlyRecord(month);
      rec.expenses += amount;
      rec.ownedProfit -= amount;
    }

    // Process member projects
    for (const row of memberProjectsQuery.rows as unknown as MemberProjectRow[]) {
      const month = row.project_month;
      const payment = Number(row.total_payment || 0);
      
      const rec = getMonthlyRecord(month);
      rec.revenue += payment;
      rec.memberEarnings += payment;
    }

    // Calculate profit
    for (const month of Object.keys(monthlyData)) {
      const rec = monthlyData[month];
      rec.profit = rec.ownedProfit + rec.memberEarnings;
    }

    // Process crew payouts roster
    const crewPayoutsList = (crewPayoutsQuery.rows as unknown as CrewPayoutRow[]).map((row) => {
      const email = row.email;
      const name = row.name || email.split('@')[0];
      const initials = getInitials(name);
      const avatarColor = getAvatarColor(email);

      return {
        userId: row.user_id,
        name,
        email,
        initials,
        avatarColor,
        totalPaid: Number(row.total_paid || 0),
        totalUnpaid: Number(row.total_unpaid || 0),
      };
    });

    // Free sees a rolling 12-month window; Pro sees all time. Trimmed here
    // rather than client-side so the full history never leaves the server.
    const pro = await isProUser(userId);
    const cutoff = pro ? null : freeAnalyticsCutoffMonth();
    const timeSeries = Object.entries(monthlyData)
      .filter(([month]) => !cutoff || month >= cutoff)
      .map(([month, data]) => ({ month, ...data }));

    return sendSuccess(res, 200, {
      timeSeries,
      crewPayouts: crewPayoutsList,
      plan: pro ? 'pro' : 'free',
      analyticsWindowMonths: pro ? null : FREE_ANALYTICS_MONTHS,
      /** Confirmed shoots: received from clients so far, and still due. */
      clientReceived: Number(receivables.received),
      clientDue: Number(receivables.due),
    }, 'Analytics data compiled successfully');
  } catch (error) {
    console.error('Error generating analytics:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to generate analytics' });
  }
});

// GET /projects/earnings-history — paginated, searchable earnings list sorted by last shoot day DESC
router.get('/projects/earnings-history', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    if (!(await isProUser(userId))) {
      return sendProRequired(res, 'Full earnings history is a Pro feature.');
    }

    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
    const limit = 50;
    const offset = (page - 1) * limit;
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';

    // 1. Fetch owned projects (with optional search)
    // Inquiries are unconfirmed leads, not earnings: excluded here exactly as
    // in /projects/analytics, so the two pages always agree.
    const allOwnedProjects = await db
      .select()
      .from(projects)
      .where(and(eq(projects.ownerId, userId), ne(projects.status, 'inquiry')));

    // 2. Fetch member projects
    const allMemberRows = await db
      .select({
        project: projects,
        payment: shootMembers.payment,
        paymentStatus: shootMembers.paymentStatus,
        membershipId: shootMembers.id,
      })
      .from(shootMembers)
      .innerJoin(projects, eq(shootMembers.projectId, projects.id))
      .where(and(eq(shootMembers.userId, userId), ne(projects.status, 'inquiry')));

    // 3. Fetch last shoot day for all relevant project IDs
    const allProjectIds = [
      ...allOwnedProjects.map(p => p.id),
      ...allMemberRows.map(r => r.project.id),
    ];

    let lastDayByProject: Record<string, string> = {};
    if (allProjectIds.length > 0) {
      const days = await db
        .select({ projectId: shootDays.projectId, date: shootDays.date })
        .from(shootDays)
        .where(inArray(shootDays.projectId, allProjectIds))
        .orderBy(desc(shootDays.date));

      for (const d of days) {
        if (!lastDayByProject[d.projectId]) {
          lastDayByProject[d.projectId] = d.date;
        }
      }
    }

    // 4. Fetch owner details for member projects
    const ownerIds = [...new Set(allMemberRows.map(r => r.project.ownerId))];
    let ownerMap: Record<string, { name: string | null; email: string }> = {};
    if (ownerIds.length > 0) {
      const ownerRows = await db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(inArray(users.id, ownerIds));
      for (const o of ownerRows) {
        ownerMap[o.id] = { name: o.name, email: o.email };
      }
    }

    // 5. Fetch expenses and crew payouts for owned projects
    let expensesByProject: Record<string, number> = {};
    let crewByProject: Record<string, number> = {};

    if (allOwnedProjects.length > 0) {
      const ownedIds = allOwnedProjects.map(p => p.id);

      const expRows = await db
        .select({ projectId: expenses.projectId, amount: expenses.amount })
        .from(expenses)
        .where(inArray(expenses.projectId, ownedIds));

      for (const e of expRows) {
        expensesByProject[e.projectId] = (expensesByProject[e.projectId] || 0) + e.amount;
      }

      const memberRows = await db
        .select({ projectId: shootMembers.projectId, payment: shootMembers.payment })
        .from(shootMembers)
        .where(inArray(shootMembers.projectId, ownedIds));

      for (const m of memberRows) {
        crewByProject[m.projectId] = (crewByProject[m.projectId] || 0) + m.payment;
      }
    }

    // 6. Build unified entry list
    type HistoryEntry = {
      projectId: string;
      title: string;
      client: string;
      status: string;
      role: 'owner' | 'crew';
      lastShootDate: string | null;
      budget: number;
      expenses: number;
      crewPayouts: number;
      myEarning: number;
      ownerName: string | null;
      ownerEmail: string | null;
    };

    const entries: HistoryEntry[] = [];

    for (const proj of allOwnedProjects) {
      const totalExp = expensesByProject[proj.id] || 0;
      const totalCrew = crewByProject[proj.id] || 0;
      const myEarning = proj.budget - totalExp - totalCrew;

      entries.push({
        projectId: proj.id,
        title: proj.title,
        client: proj.client,
        status: proj.status,
        role: 'owner',
        lastShootDate: lastDayByProject[proj.id] || null,
        budget: proj.budget,
        expenses: totalExp,
        crewPayouts: totalCrew,
        myEarning,
        ownerName: null,
        ownerEmail: null,
      });
    }

    for (const row of allMemberRows) {
      const owner = ownerMap[row.project.ownerId];
      entries.push({
        projectId: row.project.id,
        title: row.project.title,
        client: row.project.client,
        status: row.project.status,
        role: 'crew',
        lastShootDate: lastDayByProject[row.project.id] || null,
        // Crew never see the owner's real project budget — same invariant as
        // stripProjectForMember(); myEarning below is their own pay, which is fine.
        budget: 0,
        expenses: 0,
        crewPayouts: 0,
        myEarning: row.payment,
        ownerName: owner?.name ?? null,
        ownerEmail: owner?.email ?? null,
      });
    }

    // 7. Sort descending by lastShootDate, then createdAt as fallback
    entries.sort((a, b) => {
      const da = a.lastShootDate ?? '';
      const db_ = b.lastShootDate ?? '';
      if (da === db_) return 0;
      if (!da) return 1;
      if (!db_) return -1;
      return db_.localeCompare(da);
    });

    // 8. Apply search filter
    const filtered = q
      ? entries.filter(e =>
          e.title.toLowerCase().includes(q) ||
          e.client.toLowerCase().includes(q)
        )
      : entries;

    // 9. Paginate
    const total = filtered.length;
    const pages = Math.ceil(total / limit) || 1;
    const paginated = filtered.slice(offset, offset + limit);

    return sendSuccess(res, 200, {
      items: paginated,
      pagination: { total, page, limit, pages },
    }, 'Earnings history fetched successfully');
  } catch (error) {
    console.error('Error fetching earnings history:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to fetch earnings history' });
  }
});

// POST /projects — create project + shoot days atomically. The Free-plan
// check, the project and its days are one transaction under a per-owner lock,
// so two shoots created at the same moment can't both slip under the limit.
router.post('/projects', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const fields = validateProjectFields(body, { partial: false });
    const inputDays = body.shootDays;
    const days: ShootDayValue[] = [];
    if (!Array.isArray(inputDays) || inputDays.length === 0) {
      fields.shootDays = 'At least one shoot day is required';
    } else if (inputDays.length > MAX_SHOOT_DAYS) {
      fields.shootDays = `A shoot can have up to ${MAX_SHOOT_DAYS} days`;
    } else {
      inputDays.forEach((raw, i) => {
        const day = (raw ?? {}) as Record<string, unknown>;
        const checked = validateShootDay(
          { date: day.date, time: day.time, locationJSON: { name: day.locationName ?? '' }, eventTitle: day.notes },
          `shootDays[${i}].`,
        );
        if (checked.ok) days.push(checked.value);
        else Object.assign(fields, checked.fields);
      });
    }
    if (Object.keys(fields).length > 0) return validationError(res, fields);

    const pro = await isProUser(userId);
    const projectId = crypto.randomUUID();
    const values = projectUpdateValues(body);
    const underLimit = pro
      ? sql`TRUE`
      : sql`(SELECT count(*) FROM projects WHERE owner_id = ${userId}::uuid) < ${FREE_SHOOT_LIMIT}`;
    const dayRows = sql.join(
      days.map((d, i) => sql`(${projectId}::uuid, ${d.date}, ${d.time}, ${JSON.stringify(d.locationJSON)}::jsonb, ${i + 1}::int, ${d.eventTitle})`),
      sql`, `,
    );

    const [, created] = await db.batch([
      db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`projects:${userId}`}))`),
      db.execute(sql`
        INSERT INTO projects (id, owner_id, title, client, status, budget, icon, notes)
        SELECT ${projectId}::uuid, ${userId}::uuid, ${values.title!}, ${values.client!}, ${values.status ?? 'inquiry'},
               ${values.budget!}, ${values.icon ?? null}, ${values.notes ?? null}
        WHERE ${underLimit}
        RETURNING id`),
      db.execute(sql`
        INSERT INTO shoot_days (project_id, date, time, location_json, shoot_order, event_title)
        SELECT * FROM (VALUES ${dayRows}) AS v(project_id, date, time, location_json, shoot_order, event_title)
        WHERE EXISTS (SELECT 1 FROM projects WHERE id = ${projectId}::uuid)`),
    ]);

    if (created.rows.length === 0) {
      return sendProRequired(res, `Free covers ${FREE_SHOOT_LIMIT} shoots. Upgrade to Pro to create unlimited shoots.`);
    }

    const [[newProject], insertedDays, [owner]] = await Promise.all([
      db.select().from(projects).where(eq(projects.id, projectId)).limit(1),
      db.select().from(shootDays).where(eq(shootDays.projectId, projectId)).orderBy(asc(shootDays.shootOrder)),
      db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, userId)).limit(1),
    ]);

    return sendSuccess(
      res,
      201,
      { project: shapeProject(newProject, owner?.name ?? userId, owner?.email ?? '', insertedDays, [], []) },
      'Project created successfully'
    );
  } catch (error) {
    console.error('Error creating project:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create project' });
  }
});

// GET /projects — list all projects for the user with shoot days
router.get('/projects', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    // Parse Date & Timeframe filters
    const { timeframe, startDate, endDate, year, month, status, q } = req.query;
    let matchingProjectIds: string[] | null = null;

    if (timeframe || startDate || endDate || year) {
      const conditions = [];
      const now = new Date();
      const todayStr = now.toISOString().split('T')[0];

      if (timeframe === 'upcoming_7') {
        const nextWeek = new Date();
        nextWeek.setDate(nextWeek.getDate() + 7);
        const nextWeekStr = nextWeek.toISOString().split('T')[0];
        conditions.push(gte(shootDays.date, todayStr));
        conditions.push(lte(shootDays.date, nextWeekStr));
      } else if (timeframe === 'upcoming_30') {
        const nextMonth = new Date();
        nextMonth.setDate(nextMonth.getDate() + 30);
        const nextMonthStr = nextMonth.toISOString().split('T')[0];
        conditions.push(gte(shootDays.date, todayStr));
        conditions.push(lte(shootDays.date, nextMonthStr));
      } else if (timeframe === 'past') {
        conditions.push(lte(shootDays.date, todayStr));
      } else if (timeframe === 'custom' || (!timeframe && (startDate || endDate))) {
        if (startDate && typeof startDate === 'string') {
          conditions.push(gte(shootDays.date, startDate));
        }
        if (endDate && typeof endDate === 'string') {
          conditions.push(lte(shootDays.date, endDate));
        }
      }

      if (year) {
        const y = parseInt(year as string, 10);
        if (!isNaN(y)) {
          if (month) {
            const m = parseInt(month as string, 10);
            if (!isNaN(m)) {
              const prefix = `${y}-${String(m).padStart(2, '0')}`;
              conditions.push(like(shootDays.date, `${prefix}%`));
            }
          } else {
            const prefix = `${y}-`;
            conditions.push(like(shootDays.date, `${prefix}%`));
          }
        }
      }

      if (conditions.length > 0) {
        const matchedDays = await db
          .select({ projectId: shootDays.projectId })
          .from(shootDays)
          .where(and(...conditions));
        
        matchingProjectIds = Array.from(new Set(matchedDays.map((d) => d.projectId)));
      }
    }

    // Parse pagination parameters
    const limit = parseLimit(req.query.limit, 50);
    const page = parsePage(req.query.page);
    const offset = (page - 1) * limit;

    const baseConditions = [
      or(
        eq(projects.ownerId, userId),
        eq(shootMembers.userId, userId)
      )
    ];

    if (status && status !== 'all') {
      baseConditions.push(eq(projects.status, status as string));
    }

    if (q && typeof q === 'string' && q.trim()) {
      const searchPattern = `%${q.trim().toLowerCase()}%`;
      baseConditions.push(
        or(
          like(sql`lower(${projects.title})`, searchPattern),
          like(sql`lower(${projects.client})`, searchPattern),
          like(sql`lower(${shootDays.locationJSON}->>'name')`, searchPattern)
        )
      );
    }

    if (matchingProjectIds !== null) {
      if (matchingProjectIds.length === 0) {
        return sendSuccess(
          res,
          200,
          { projects: [], pagination: { total: 0, page, limit, pages: 0 } },
          'Projects fetched successfully'
        );
      }
      baseConditions.push(inArray(projects.id, matchingProjectIds));
    }

    // Get total count of distinct projects
    const countResult = await db
      .select({ count: sql<number>`count(distinct ${projects.id})` })
      .from(projects)
      .leftJoin(shootMembers, eq(projects.id, shootMembers.projectId))
      .leftJoin(shootDays, eq(projects.id, shootDays.projectId))
      .where(and(...baseConditions));

    const total = Number(countResult[0]?.count ?? 0);
    const pages = Math.ceil(total / limit);

    if (total === 0) {
      return sendSuccess(
        res,
        200,
        { projects: [], pagination: { total, page, limit, pages } },
        'Projects fetched successfully'
      );
    }

    // Fetch the project IDs for the current page
    // We order them by the project creation date (createdAt) descending (latest created at the top)
    const paginatedProjectIdsRows = await db
      .select({
        id: projects.id,
      })
      .from(projects)
      .leftJoin(shootMembers, eq(projects.id, shootMembers.projectId))
      .leftJoin(shootDays, eq(projects.id, shootDays.projectId))
      .where(and(...baseConditions))
      .groupBy(projects.id, projects.createdAt)
      .orderBy(desc(projects.createdAt))
      .limit(limit)
      .offset(offset);

    const projectIds = paginatedProjectIdsRows.map((r) => r.id);

    if (projectIds.length === 0) {
      return sendSuccess(
        res,
        200,
        { projects: [], pagination: { total, page, limit, pages } },
        'Projects fetched successfully'
      );
    }

    // Fetch full projects details for these IDs only
    const rows = await db
      .select({ project: projects, ownerName: users.name, ownerEmail: users.email })
      .from(projects)
      .innerJoin(users, eq(projects.ownerId, users.id))
      .where(inArray(projects.id, projectIds));

    // 2. Fetch all shoot days for those projects in one query
    const allDays = await db
      .select()
      .from(shootDays)
      .where(inArray(shootDays.projectId, projectIds))
      .orderBy(asc(shootDays.shootOrder));

    // 3. Group days by project
    const daysByProject = new Map<string, (typeof shootDays.$inferSelect)[]>();
    for (const day of allDays) {
      if (!daysByProject.has(day.projectId)) daysByProject.set(day.projectId, []);
      daysByProject.get(day.projectId)!.push(day);
    }

    // Fetch all expenses for those projects in one query
    const allExpenses = await db
      .select()
      .from(expenses)
      .where(inArray(expenses.projectId, projectIds))
      .orderBy(asc(expenses.createdAt));

    // Group expenses by project
    const expensesByProject = new Map<string, (typeof expenses.$inferSelect)[]>();
    for (const exp of allExpenses) {
      if (!expensesByProject.has(exp.projectId)) expensesByProject.set(exp.projectId, []);
      expensesByProject.get(exp.projectId)!.push(exp);
    }

    // Fetch all shoot members for those projects in one query
    const allMembers = await db
      .select({
        id: shootMembers.id,
        projectId: shootMembers.projectId,
        userId: shootMembers.userId,
        name: users.name,
        email: users.email,
        payment: shootMembers.payment,
        amountPaid: shootMembers.amountPaid,
        paymentStatus: shootMembers.paymentStatus,
        invited: shootMembers.invited,
      })
      .from(shootMembers)
      .leftJoin(users, eq(shootMembers.userId, users.id))
      .where(inArray(shootMembers.projectId, projectIds));

    // Group members by project
    const membersByProject = new Map<string, typeof allMembers>();
    for (const m of allMembers) {
      if (!membersByProject.has(m.projectId)) membersByProject.set(m.projectId, []);
      membersByProject.get(m.projectId)!.push(m);
    }

    // Fetch all delivery timeline milestones for those projects in one query
    const allMilestones = await db
      .select()
      .from(shootMilestones)
      .where(inArray(shootMilestones.projectId, projectIds));

    const milestonesByProject = new Map<string, typeof allMilestones>();
    for (const m of allMilestones) {
      if (!milestonesByProject.has(m.projectId)) milestonesByProject.set(m.projectId, []);
      milestonesByProject.get(m.projectId)!.push(m);
    }

    // 4. Shape
    const shaped = rows.map((r) => {
      const isOwner = r.project.ownerId === userId;
      let project = shapeProject(
        r.project,
        r.ownerName || r.ownerEmail || r.project.ownerId,
        r.ownerEmail || '',
        daysByProject.get(r.project.id) ?? [],
        expensesByProject.get(r.project.id) ?? [],
        membersByProject.get(r.project.id) ?? [],
        milestonesByProject.get(r.project.id) ?? []
      );

      if (!isOwner) {
        project = stripProjectForMember(project, userId);
      }

      return project;
    });

    // Sort final shaped projects to match the order of projectIds
    const shapedMap = new Map(shaped.map((p) => [p.id, p]));
    const sortedShaped = projectIds
      .map((id) => shapedMap.get(id))
      .filter((p): p is NonNullable<typeof p> => p !== undefined);

    return sendSuccess(
      res,
      200,
      { projects: sortedShaped, pagination: { total, page, limit, pages } },
      'Projects fetched successfully'
    );
  } catch (error) {
    console.error('Error fetching projects:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to fetch projects' });
  }
});

// GET /projects/:id
router.get('/projects/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const id = String(req.params.id);
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    // Check if user is owner
    let [projectData] = await db
      .select({ project: projects, ownerName: users.name, ownerEmail: users.email })
      .from(projects)
      .innerJoin(users, eq(projects.ownerId, users.id))
      .where(and(eq(projects.id, id), eq(projects.ownerId, userId)))
      .limit(1);

    if (!projectData) {
      // Check if user is a shoot member
      const [isMember] = await db
        .select()
        .from(shootMembers)
        .where(and(eq(shootMembers.projectId, id), eq(shootMembers.userId, userId)))
        .limit(1);

      if (!isMember) {
        return sendError(res, 404, { code: 'NOT_FOUND', message: 'Project not found' });
      }

      // Fetch project details for crew
      [projectData] = await db
        .select({ project: projects, ownerName: users.name, ownerEmail: users.email })
        .from(projects)
        .innerJoin(users, eq(projects.ownerId, users.id))
        .where(eq(projects.id, id))
        .limit(1);
    }

    const days = await db
      .select()
      .from(shootDays)
      .where(eq(shootDays.projectId, id))
      .orderBy(asc(shootDays.shootOrder));

    const exps = await db
      .select()
      .from(expenses)
      .where(eq(expenses.projectId, id))
      .orderBy(asc(expenses.createdAt));

    const members = await db
      .select({
        id: shootMembers.id,
        userId: shootMembers.userId,
        name: users.name,
        email: users.email,
        payment: shootMembers.payment,
        amountPaid: shootMembers.amountPaid,
        paymentStatus: shootMembers.paymentStatus,
        invited: shootMembers.invited,
      })
      .from(shootMembers)
      .leftJoin(users, eq(shootMembers.userId, users.id))
      .where(eq(shootMembers.projectId, id));

    const milestones = await db
      .select()
      .from(shootMilestones)
      .where(eq(shootMilestones.projectId, id));

    const isOwner = projectData.project.ownerId === userId;
    // Owners see every payout; crew only ever get their own (stripProjectForMember
    // blanks the rest), and never the client's payments.
    const [payouts, payments] = await Promise.all([
      members.length
        ? db.select().from(crewPayouts).where(inArray(crewPayouts.shootMemberId, members.map((m) => m.id)))
        : Promise.resolve([] as (typeof crewPayouts.$inferSelect)[]),
      isOwner
        ? db.select().from(clientPayments).where(eq(clientPayments.projectId, id))
        : Promise.resolve([] as (typeof clientPayments.$inferSelect)[]),
    ]);
    const membersWithPayouts = members.map((m) => ({ ...m, payouts: payouts.filter((p) => p.shootMemberId === m.id) }));

    let shapedProject = shapeProject(
      projectData.project,
      projectData.ownerName || projectData.ownerEmail || projectData.project.ownerId,
      projectData.ownerEmail ?? '',
      days,
      exps,
      membersWithPayouts,
      milestones,
      payments
    );

    if (!isOwner) {
      shapedProject = stripProjectForMember(shapedProject, userId);
    }

    return sendSuccess(
      res,
      200,
      { project: shapedProject },
      'Project fetched successfully'
    );
  } catch (error) {
    console.error('Error fetching project:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to fetch project' });
  }
});

// PUT /projects/:id
router.put('/projects/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const id = String(req.params.id);
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const fields = validateProjectFields(body, { partial: true });
    if (Object.keys(fields).length > 0) return validationError(res, fields);

    const [updatedProject] = await db
      .update(projects)
      .set({ ...projectUpdateValues(body), updatedAt: new Date() })
      .where(and(eq(projects.id, id), eq(projects.ownerId, userId)))
      .returning();

    if (!updatedProject) {
      return sendError(res, 404, { code: 'NOT_FOUND', message: 'Project not found' });
    }

    // A new budget can make received money "in full" or no longer so.
    if (body.budget !== undefined && updatedProject.amountReceived > 0) {
      await recomputeProject(id);
      const [fresh] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
      Object.assign(updatedProject, fresh);
    }

    // Re-fetch shoot days to return a fully shaped project
    const days = await db
      .select()
      .from(shootDays)
      .where(eq(shootDays.projectId, id))
      .orderBy(asc(shootDays.shootOrder));

    const exps = await db
      .select()
      .from(expenses)
      .where(eq(expenses.projectId, id))
      .orderBy(asc(expenses.createdAt));

    const [owner] = await db
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const members = await db
      .select({
        id: shootMembers.id,
        userId: shootMembers.userId,
        name: users.name,
        email: users.email,
        payment: shootMembers.payment,
        amountPaid: shootMembers.amountPaid,
        paymentStatus: shootMembers.paymentStatus,
        invited: shootMembers.invited,
      })
      .from(shootMembers)
      .leftJoin(users, eq(shootMembers.userId, users.id))
      .where(eq(shootMembers.projectId, id));

    const milestones = await db
      .select()
      .from(shootMilestones)
      .where(eq(shootMilestones.projectId, id));

    return sendSuccess(
      res,
      200,
      { project: shapeProject(updatedProject, owner?.name ?? userId, owner?.email ?? '', days, exps, members, milestones) },
      'Project updated successfully'
    );
  } catch (error) {
    console.error('Error updating project:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to update project' });
  }
});

// DELETE /projects/:id
router.delete('/projects/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const id = String(req.params.id);
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    const [deletedProject] = await db.delete(projects)
      .where(and(eq(projects.id, id), eq(projects.ownerId, userId)))
      .returning();

    if (!deletedProject) {
      return sendError(res, 404, { code: 'NOT_FOUND', message: 'Project not found' });
    }

    return sendSuccess(res, 200, {}, 'Project deleted successfully');
  } catch (error) {
    console.error('Error deleting project:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to delete project' });
  }
});

// Shoot Days Endpoints
// POST /projects/:projectId/days
router.post('/projects/:projectId/days', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const projectId = String(req.params.projectId);
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    const project = await requireProjectOwner(projectId, userId, res);
    if (!project) return;

    const checked = validateShootDay(req.body ?? {});
    if (!checked.ok) return validationError(res, checked.fields);
    const shootOrder = Number.isInteger(req.body?.shootOrder) ? Math.min(Math.max(req.body.shootOrder, 1), 1000) : 1;

    const [newDay] = await db.insert(shootDays).values({ projectId, ...checked.value, shootOrder }).returning();

    return sendSuccess(res, 201, { shootDay: newDay }, 'Shoot day created successfully');
  } catch (error) {
    console.error('Error creating shoot day:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create shoot day' });
  }
});

// PUT /projects/:projectId/days/:dayId
router.put('/projects/:projectId/days/:dayId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const projectId = String(req.params.projectId);
    const dayId = String(req.params.dayId);
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    const project = await requireProjectOwner(projectId, userId, res);
    if (!project) return;

    const checked = validateShootDay(req.body ?? {});
    if (!checked.ok) return validationError(res, checked.fields);

    const [updatedDay] = await db.update(shootDays)
      .set({ ...checked.value, updatedAt: new Date() })
      .where(and(eq(shootDays.id, dayId), eq(shootDays.projectId, projectId)))
      .returning();

    if (!updatedDay) return sendError(res, 404, { code: 'NOT_FOUND', message: 'Shoot day not found' });

    return sendSuccess(res, 200, { shootDay: updatedDay }, 'Shoot day updated successfully');
  } catch (error) {
    console.error('Error updating shoot day:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to update shoot day' });
  }
});

// DELETE /projects/:projectId/days/:dayId
router.delete('/projects/:projectId/days/:dayId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const projectId = String(req.params.projectId);
    const dayId = String(req.params.dayId);
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    const project = await requireProjectOwner(projectId, userId, res);
    if (!project) return;

    const [deletedDay] = await db.delete(shootDays)
      .where(and(eq(shootDays.id, dayId), eq(shootDays.projectId, projectId)))
      .returning();

    if (!deletedDay) return sendError(res, 404, { code: 'NOT_FOUND', message: 'Shoot day not found' });

    return sendSuccess(res, 200, {}, 'Shoot day deleted successfully');
  } catch (error) {
    console.error('Error deleting shoot day:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to delete shoot day' });
  }
});

// GET /projects/:projectId/expenses
router.get('/projects/:projectId/expenses', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const projectId = String(req.params.projectId);
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    const project = await requireProjectOwner(projectId, userId, res);
    if (!project) return;

    const exps = await db
      .select()
      .from(expenses)
      .where(eq(expenses.projectId, projectId))
      .orderBy(asc(expenses.createdAt));

    const shapedExpenses = exps.map((e) => ({
      id: e.id,
      label: e.label,
      amount: e.amount,
      category: (e.category ?? 'misc') as 'equipment' | 'travel' | 'food' | 'props' | 'venue' | 'misc',
      date: e.date ?? undefined,
    }));

    return sendSuccess(res, 200, { expenses: shapedExpenses }, 'Expenses fetched successfully');
  } catch (error) {
    console.error('Error fetching expenses:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to fetch expenses' });
  }
});

// POST /projects/:projectId/expenses
router.post('/projects/:projectId/expenses', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const projectId = String(req.params.projectId);
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    const project = await requireProjectOwner(projectId, userId, res);
    if (!project) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const fields = validateExpense(body);
    if (Object.keys(fields).length > 0) return validationError(res, fields);

    const [newExpense] = await db.insert(expenses).values(expenseValues(projectId, body)).returning();

    const shapedExpense = {
      id: newExpense.id,
      label: newExpense.label,
      amount: newExpense.amount,
      category: (newExpense.category ?? 'misc') as 'equipment' | 'travel' | 'food' | 'props' | 'venue' | 'misc',
      date: newExpense.date ?? undefined,
    };

    return sendSuccess(res, 201, { expense: shapedExpense }, 'Expense added successfully');
  } catch (error) {
    console.error('Error adding expense:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to add expense' });
  }
});

// DELETE /projects/:projectId/expenses/:expenseId
router.delete('/projects/:projectId/expenses/:expenseId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const projectId = String(req.params.projectId);
    const expenseId = String(req.params.expenseId);
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    const project = await requireProjectOwner(projectId, userId, res);
    if (!project) return;

    const [deletedExpense] = await db
      .delete(expenses)
      .where(and(eq(expenses.id, expenseId), eq(expenses.projectId, projectId)))
      .returning();

    if (!deletedExpense) {
      return sendError(res, 404, { code: 'NOT_FOUND', message: 'Expense not found' });
    }

    return sendSuccess(res, 200, {}, 'Expense deleted successfully');
  } catch (error) {
    console.error('Error deleting expense:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to delete expense' });
  }
});

// ─── Delivery Timeline / Milestones ─────────────────────────────────────────
// Separate from `status` (the inquiry/booked/paid business pipeline) — this
// tracks what's actually happening with the shoot day-to-day (shooting,
// editing, delivered), visible to crew today and to clients via the public
// share page once that's enabled.

// POST /projects/:projectId/milestones
router.post('/projects/:projectId/milestones', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const projectId = String(req.params.projectId);
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    if (!(await isProUser(userId))) {
      return sendProRequired(res, 'The client delivery timeline is a Pro feature.');
    }

    const project = await requireProjectOwner(projectId, userId, res);
    if (!project) return;

    const { stage, note, date } = req.body;
    const fields = validateMilestone(req.body ?? {});
    if (Object.keys(fields).length > 0) return validationError(res, fields);

    const [newMilestone] = await db.insert(shootMilestones).values({
      projectId,
      stage: stage.trim(),
      note: note.trim(),
      date: date.trim(),
    }).returning();

    // Keep the denormalized "current stage" on the project in sync.
    await db.update(projects)
      .set({ productionStage: newMilestone.stage, updatedAt: new Date() })
      .where(eq(projects.id, projectId));

    return sendSuccess(
      res,
      201,
      { milestone: shapeMilestone(newMilestone), productionStage: newMilestone.stage },
      'Milestone added successfully'
    );
  } catch (error) {
    console.error('Error adding milestone:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to add milestone' });
  }
});

// DELETE /projects/:projectId/milestones/:milestoneId
router.delete('/projects/:projectId/milestones/:milestoneId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const projectId = String(req.params.projectId);
    const milestoneId = String(req.params.milestoneId);
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    const project = await requireProjectOwner(projectId, userId, res);
    if (!project) return;

    const [deletedMilestone] = await db.delete(shootMilestones)
      .where(and(eq(shootMilestones.id, milestoneId), eq(shootMilestones.projectId, projectId)))
      .returning();

    if (!deletedMilestone) {
      return sendError(res, 404, { code: 'NOT_FOUND', message: 'Milestone not found' });
    }

    // Recompute the denormalized current stage from what's left, falling
    // back to 'booked' (the same default a project starts with) if the
    // timeline is now empty.
    const [latest] = await db
      .select()
      .from(shootMilestones)
      .where(eq(shootMilestones.projectId, projectId))
      .orderBy(desc(shootMilestones.createdAt))
      .limit(1);

    const newStage = latest?.stage ?? 'booked';
    await db.update(projects)
      .set({ productionStage: newStage, updatedAt: new Date() })
      .where(eq(projects.id, projectId));

    return sendSuccess(res, 200, { productionStage: newStage }, 'Milestone deleted successfully');
  } catch (error) {
    console.error('Error deleting milestone:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to delete milestone' });
  }
});

// ─── Client-facing sharing ───────────────────────────────────────────────────
// Owner-only controls for the public, read-only share page at
// GET /public/shoot/:token (routes/public.ts — no auth, mounted separately).

// POST /projects/:projectId/share — enable sharing, minting a token on first use
router.post('/projects/:projectId/share', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const projectId = String(req.params.projectId);
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    const project = await requireProjectOwner(projectId, userId, res);
    if (!project) return;

    const token = project.shareToken ?? generateShareToken();

    const [updated] = await db.update(projects)
      .set({ shareToken: token, shareEnabled: true, updatedAt: new Date() })
      .where(eq(projects.id, projectId))
      .returning();

    return sendSuccess(res, 200, { shareToken: updated.shareToken, shareEnabled: updated.shareEnabled }, 'Sharing enabled');
  } catch (error) {
    console.error('Error enabling sharing:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to enable sharing' });
  }
});

// DELETE /projects/:projectId/share — disable sharing (token kept so re-enabling doesn't change the link)
router.delete('/projects/:projectId/share', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const projectId = String(req.params.projectId);
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    const project = await requireProjectOwner(projectId, userId, res);
    if (!project) return;

    await db.update(projects)
      .set({ shareEnabled: false, updatedAt: new Date() })
      .where(eq(projects.id, projectId));

    return sendSuccess(res, 200, { shareEnabled: false }, 'Sharing disabled');
  } catch (error) {
    console.error('Error disabling sharing:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to disable sharing' });
  }
});

// POST /projects/:projectId/share/reset — revoke the old link and mint a new token
router.post('/projects/:projectId/share/reset', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const projectId = String(req.params.projectId);
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    const project = await requireProjectOwner(projectId, userId, res);
    if (!project) return;

    const token = generateShareToken();
    const [updated] = await db.update(projects)
      .set({ shareToken: token, updatedAt: new Date() })
      .where(eq(projects.id, projectId))
      .returning();

    return sendSuccess(res, 200, { shareToken: updated.shareToken, shareEnabled: updated.shareEnabled }, 'Share link reset');
  } catch (error) {
    console.error('Error resetting share link:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to reset share link' });
  }
});

// ─── Part payments ──────────────────────────────────────────────────────────
// Money in from the client and out to crew, one row per payment. Adding or
// removing a row and recomputing the totals/status is a single transaction.

/** One crew member in the API shape, with their payouts. */
async function loadMember(memberId: string) {
  const [row] = await db
    .select({
      id: shootMembers.id,
      userId: shootMembers.userId,
      name: users.name,
      email: users.email,
      payment: shootMembers.payment,
      amountPaid: shootMembers.amountPaid,
      paymentStatus: shootMembers.paymentStatus,
      invited: shootMembers.invited,
    })
    .from(shootMembers)
    .leftJoin(users, eq(shootMembers.userId, users.id))
    .where(eq(shootMembers.id, memberId))
    .limit(1);
  const payouts = await db.select().from(crewPayouts).where(eq(crewPayouts.shootMemberId, memberId));
  return shapeTeamMember({ ...row, payouts });
}

/** The project's money-in summary after a change. */
async function loadReceipts(projectId: string) {
  const [[p], rows] = await Promise.all([
    db.select({ amountReceived: projects.amountReceived, status: projects.status, budget: projects.budget })
      .from(projects).where(eq(projects.id, projectId)).limit(1),
    db.select().from(clientPayments).where(eq(clientPayments.projectId, projectId)),
  ]);
  return {
    amountReceived: p.amountReceived,
    status: p.status,
    budget: p.budget,
    clientPayments: rows
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.getTime() - a.createdAt.getTime())
      .map(shapeClientPayment),
  };
}

// POST /projects/:projectId/client-payments — record money received from the client
router.post('/projects/:projectId/client-payments', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const projectId = String(req.params.projectId);
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    const { fields, value } = validatePaymentEntry(req.body ?? {});
    if (Object.keys(fields).length > 0) return validationError(res, fields);

    const project = await requireProjectOwner(projectId, userId, res);
    if (!project) return;

    await db.batch([
      db.insert(clientPayments).values({ projectId, ...value }),
      recomputeProject(projectId),
    ]);
    return sendSuccess(res, 201, await loadReceipts(projectId), 'Payment recorded');
  } catch (error) {
    console.error('Error recording client payment:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to record payment' });
  }
});

// DELETE /projects/:projectId/client-payments/:paymentId
router.delete('/projects/:projectId/client-payments/:paymentId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const projectId = String(req.params.projectId);
    const paymentId = String(req.params.paymentId);
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    const project = await requireProjectOwner(projectId, userId, res);
    if (!project) return;

    const [deleted] = await db.batch([
      db.delete(clientPayments)
        .where(and(eq(clientPayments.id, paymentId), eq(clientPayments.projectId, projectId)))
        .returning({ id: clientPayments.id }),
      recomputeProject(projectId),
    ]);
    if (deleted.length === 0) return sendError(res, 404, { code: 'NOT_FOUND', message: 'Payment not found' });
    return sendSuccess(res, 200, await loadReceipts(projectId), 'Payment removed');
  } catch (error) {
    console.error('Error deleting client payment:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to remove payment' });
  }
});

// POST /projects/:projectId/members/:memberId/payouts — pay a crew member (in full or in part)
router.post('/projects/:projectId/members/:memberId/payouts', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const projectId = String(req.params.projectId);
    const memberId = String(req.params.memberId);
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    const { fields, value } = validatePaymentEntry(req.body ?? {});
    if (Object.keys(fields).length > 0) return validationError(res, fields);

    const project = await requireProjectOwner(projectId, userId, res);
    if (!project) return;

    const [member] = await db.select().from(shootMembers)
      .where(and(eq(shootMembers.id, memberId), eq(shootMembers.projectId, projectId))).limit(1);
    if (!member) return sendError(res, 404, { code: 'NOT_FOUND', message: 'Member not found' });

    const remaining = member.payment - member.amountPaid;
    if (member.payment === 0) return validationError(res, { amount: 'Set a fee for this member first' });
    if (value.amount > remaining) {
      return validationError(res, { amount: remaining > 0 ? `Only ${remaining} is left to pay on this fee` : 'This fee is already paid in full' });
    }

    await db.batch([
      db.insert(crewPayouts).values({ shootMemberId: memberId, ...value }),
      recomputeMember(memberId),
    ]);
    return sendSuccess(res, 201, { member: await loadMember(memberId) }, 'Payout recorded');
  } catch (error) {
    console.error('Error recording crew payout:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to record payout' });
  }
});

// DELETE /projects/:projectId/members/:memberId/payouts/:payoutId
router.delete('/projects/:projectId/members/:memberId/payouts/:payoutId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const projectId = String(req.params.projectId);
    const memberId = String(req.params.memberId);
    const payoutId = String(req.params.payoutId);
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    const project = await requireProjectOwner(projectId, userId, res);
    if (!project) return;

    const [member] = await db.select({ id: shootMembers.id }).from(shootMembers)
      .where(and(eq(shootMembers.id, memberId), eq(shootMembers.projectId, projectId))).limit(1);
    if (!member) return sendError(res, 404, { code: 'NOT_FOUND', message: 'Member not found' });

    const [deleted] = await db.batch([
      db.delete(crewPayouts)
        .where(and(eq(crewPayouts.id, payoutId), eq(crewPayouts.shootMemberId, memberId)))
        .returning({ id: crewPayouts.id }),
      recomputeMember(memberId),
    ]);
    if (deleted.length === 0) return sendError(res, 404, { code: 'NOT_FOUND', message: 'Payout not found' });
    return sendSuccess(res, 200, { member: await loadMember(memberId) }, 'Payout removed');
  } catch (error) {
    console.error('Error deleting crew payout:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to remove payout' });
  }
});

// ─── Bulk edit ──────────────────────────────────────────────────────────────

// PUT /projects/:projectId/edits — everything the shoot detail screen's Save
// changes, applied in one transaction: either all of it lands or none does.
// New crew are added afterwards through POST /members, because that creates
// accounts and sends emails, which can't be rolled back.
router.put('/projects/:projectId/edits', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const projectId = String(req.params.projectId);
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    const body = (req.body ?? {}) as Record<string, any>;
    const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);
    const ids = (v: unknown, key: string, fields: Record<string, string>) => {
      const arr = list(v);
      if (!arr.every(isUuid)) fields[key] = 'Invalid id';
      return arr as string[];
    };

    const fields: Record<string, string> = {};
    const projectBody = (body.project ?? {}) as Record<string, unknown>;
    Object.assign(fields, validateProjectFields(projectBody, { partial: true }));

    const deletedDayIds = ids(body.days?.deletedIds, 'days.deletedIds', fields);
    const dayUpserts = list(body.days?.upserts).map((d: Record<string, unknown>, i: number) => {
      if (!d.isNew && !isUuid(d.id)) fields[`days.upserts[${i}].id`] = 'Invalid id';
      const checked = validateShootDay(
        { date: d.date, time: d.time, locationJSON: { name: d.locationName ?? '' }, eventTitle: d.notes },
        `days.upserts[${i}].`,
      );
      if (!checked.ok) Object.assign(fields, checked.fields);
      return { isNew: Boolean(d.isNew), id: d.id as string, value: checked.ok ? checked.value : null };
    });

    const deletedExpenseIds = ids(body.expenses?.deletedIds, 'expenses.deletedIds', fields);
    const addedExpenses = list(body.expenses?.added) as Record<string, unknown>[];
    addedExpenses.forEach((e, i) => Object.assign(fields, validateExpense(e ?? {}, `expenses.added[${i}].`)));

    const deletedMilestoneIds = ids(body.milestones?.deletedIds, 'milestones.deletedIds', fields);
    const addedMilestones = list(body.milestones?.added) as Record<string, unknown>[];
    addedMilestones.forEach((m, i) => Object.assign(fields, validateMilestone(m ?? {}, `milestones.added[${i}].`)));

    const deletedMemberIds = ids(body.members?.deletedIds, 'members.deletedIds', fields);
    const updatedMembers = list(body.members?.updated) as Record<string, unknown>[];
    updatedMembers.forEach((m, i) => {
      if (!isUuid(m?.id)) fields[`members.updated[${i}].id`] = 'Invalid id';
      Object.assign(fields, validateMemberFields(m ?? {}, `members.updated[${i}].`));
    });

    if (Object.keys(fields).length > 0) return validationError(res, fields);

    const project = await requireProjectOwner(projectId, userId, res);
    if (!project) return;

    if (addedMilestones.length > 0 && !(await isProUser(userId))) {
      return sendProRequired(res, 'The client delivery timeline is a Pro feature.');
    }

    const now = new Date();
    const statements: BatchItem<'pg'>[] = [];

    if (deletedDayIds.length) {
      statements.push(db.delete(shootDays).where(and(eq(shootDays.projectId, projectId), inArray(shootDays.id, deletedDayIds))));
    }
    const newDays = dayUpserts.filter((d) => d.isNew).map((d) => ({ projectId, ...d.value!, shootOrder: 99 }));
    if (newDays.length) statements.push(db.insert(shootDays).values(newDays));
    for (const d of dayUpserts.filter((d) => !d.isNew)) {
      statements.push(
        db.update(shootDays)
          .set({ ...d.value!, updatedAt: now })
          .where(and(eq(shootDays.id, d.id), eq(shootDays.projectId, projectId)))
      );
    }

    if (deletedExpenseIds.length) {
      statements.push(db.delete(expenses).where(and(eq(expenses.projectId, projectId), inArray(expenses.id, deletedExpenseIds))));
    }
    if (addedExpenses.length) statements.push(db.insert(expenses).values(addedExpenses.map((e) => expenseValues(projectId, e))));

    if (deletedMilestoneIds.length) {
      statements.push(db.delete(shootMilestones).where(and(eq(shootMilestones.projectId, projectId), inArray(shootMilestones.id, deletedMilestoneIds))));
    }
    if (addedMilestones.length) {
      statements.push(db.insert(shootMilestones).values(addedMilestones.map((m) => ({
        projectId,
        stage: (m.stage as string).trim(),
        note: (m.note as string).trim(),
        date: m.date as string,
      }))));
    }
    // Keep the denormalised current stage in step with the timeline, unless
    // the client sends its own (the project update below then wins).
    if ((deletedMilestoneIds.length || addedMilestones.length) && projectBody.productionStage === undefined) {
      statements.push(db.execute(sql`
        UPDATE projects
        SET production_stage = COALESCE(
          (SELECT stage FROM shoot_milestones WHERE project_id = ${projectId}::uuid ORDER BY created_at DESC LIMIT 1),
          'booked')
        WHERE id = ${projectId}::uuid`));
    }

    if (deletedMemberIds.length) {
      statements.push(db.delete(shootMembers).where(and(eq(shootMembers.projectId, projectId), inArray(shootMembers.id, deletedMemberIds))));
    }
    if (updatedMembers.length) {
      const current = await db.select().from(shootMembers).where(and(
        eq(shootMembers.projectId, projectId),
        inArray(shootMembers.id, updatedMembers.map((m) => m.id as string)),
      ));
      for (const m of updatedMembers) {
        const row = current.find((r) => r.id === m.id);
        if (!row) continue;
        const change = memberChange(row, m);
        if ('error' in change) {
          return validationError(res, { [`members.updated[${updatedMembers.indexOf(m)}].payment`]: change.error });
        }
        statements.push(...change.statements);
        if (m.invited !== undefined) {
          statements.push(db.update(shootMembers).set({ invited: m.invited as boolean }).where(eq(shootMembers.id, row.id)));
        }
      }
    }

    statements.push(
      db.update(projects).set({ ...projectUpdateValues(projectBody), updatedAt: now }).where(eq(projects.id, projectId))
    );
    if (projectBody.budget !== undefined && project.amountReceived > 0) statements.push(recomputeProject(projectId));

    await db.batch(statements as [BatchItem<'pg'>, ...BatchItem<'pg'>[]]);

    return sendSuccess(res, 200, {}, 'Project saved');
  } catch (error) {
    console.error('Error saving project edits:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to save changes. Nothing was changed.' });
  }
});

// ─── Team Members / Crew Endpoints ──────────────────────────────────────────

// POST /projects/:projectId/members — add crew by email. Accepts
// `members: [{ email, payment?, paymentStatus?, invited? }]`, or the older
// `emails: string[]` / `email` with shared fields. Each new crew member gets
// an invitation email, so requests are capped and rate-limited per account.
router.post('/projects/:projectId/members', invitesByAccount, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const projectId = String(req.params.projectId);
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const shared = { payment: body.payment, paymentStatus: body.paymentStatus, invited: body.invited };
    const entries: Record<string, unknown>[] = Array.isArray(body.members)
      ? body.members.map((m) => (m && typeof m === 'object' ? (m as Record<string, unknown>) : {}))
      : Array.isArray(body.emails)
        ? body.emails.map((email) => ({ email, ...shared }))
        : typeof body.email === 'string'
          ? [{ email: body.email, ...shared }]
          : [];

    if (entries.length === 0) {
      return sendError(res, 400, { code: 'BAD_REQUEST', message: 'Valid email or emails array is required' });
    }
    if (entries.length > MAX_INVITES_PER_REQUEST) {
      return sendError(res, 400, { code: 'BAD_REQUEST', message: `Add up to ${MAX_INVITES_PER_REQUEST} crew members at a time` });
    }

    const fields: Record<string, string> = {};
    entries.forEach((m, i) => {
      if (typeof m.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.email.trim()) || m.email.length > 254) {
        fields[`members[${i}].email`] = 'Enter a valid email address';
      }
      Object.assign(fields, validateMemberFields(m, `members[${i}].`));
    });
    if (Object.keys(fields).length > 0) return validationError(res, fields);

    const project = await requireProjectOwner(projectId, userId, res);
    if (!project) return;

    const [[owner], days] = await Promise.all([
      db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, userId)).limit(1),
      db.select({ date: shootDays.date }).from(shootDays).where(eq(shootDays.projectId, projectId)),
    ]);
    const ownerName = owner?.name || owner?.email || 'Someone';
    const shootDates = days.map((d) => d.date);

    const results = [];
    const seen = new Set<string>();

    for (const entry of entries) {
      const targetEmail = (entry.email as string).trim().toLowerCase();
      if (seen.has(targetEmail)) continue;
      seen.add(targetEmail);

      // 1. Find or create the person (an unactivated placeholder until they set a password)
      let [targetUser] = await db.select().from(users).where(eq(users.email, targetEmail)).limit(1);
      if (!targetUser) {
        [targetUser] = await db.insert(users).values({ email: targetEmail, invitedBy: userId }).returning();
      }

      // 2. Already on this crew: skip before any email, so a retry doesn't re-notify them.
      const [existingMember] = await db.select({ id: shootMembers.id }).from(shootMembers).where(and(
        eq(shootMembers.projectId, projectId),
        eq(shootMembers.userId, targetUser.id)
      )).limit(1);
      if (existingMember) continue;

      // 3. Add to the crew with their fee, then to the owner's circle.
      const [newMember] = await db.insert(shootMembers).values({
        projectId,
        userId: targetUser.id,
        payment: entry.payment !== undefined ? parseMoney(entry.payment)! : 0,
        paymentStatus: entry.paymentStatus === 'paid' ? 'paid' : 'unpaid',
        invited: typeof entry.invited === 'boolean' ? entry.invited : true,
      }).returning();

      await db.insert(teamMembers).values({ userId, memberId: targetUser.id }).onConflictDoNothing();

      // 4. Only now that they're on the crew, tell them. A row created by an
      // earlier invite may still have no password, so check the account itself.
      sendInvitationEmail(
        targetEmail,
        ownerName,
        project.title,
        project.client,
        shootDates,
        !targetUser.passwordHash,
        projectId
      ).catch((err) => {
        console.error(`Failed to send invitation email to ${targetEmail}:`, err);
      });

      results.push(shapeTeamMember({
        id: newMember.id,
        userId: targetUser.id,
        name: targetUser.name || null,
        email: targetUser.email,
        payment: newMember.payment,
        amountPaid: newMember.amountPaid,
        paymentStatus: newMember.paymentStatus,
        invited: newMember.invited,
      }));
    }

    return sendSuccess(res, 201, { members: results }, 'Team member(s) added successfully');
  } catch (error) {
    console.error('Error adding project member:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to add project member' });
  }
});

// PUT /projects/:projectId/members/:memberId
router.put('/projects/:projectId/members/:memberId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const projectId = String(req.params.projectId);
    const memberId = String(req.params.memberId);
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    const project = await requireProjectOwner(projectId, userId, res);
    if (!project) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const fields = validateMemberFields(body);
    if (Object.keys(fields).length > 0) return validationError(res, fields);

    const [member] = await db.select().from(shootMembers)
      .where(and(eq(shootMembers.id, memberId), eq(shootMembers.projectId, projectId))).limit(1);
    if (!member) return sendError(res, 404, { code: 'NOT_FOUND', message: 'Member not found' });

    const change = memberChange(member, body);
    if ('error' in change) return validationError(res, { payment: change.error });
    const statements: BatchItem<'pg'>[] = [...change.statements];
    if (body.invited !== undefined) {
      statements.push(db.update(shootMembers).set({ invited: body.invited as boolean }).where(eq(shootMembers.id, memberId)));
    }
    await db.batch(statements as [BatchItem<'pg'>, ...BatchItem<'pg'>[]]);

    return sendSuccess(res, 200, { member: await loadMember(memberId) }, 'Team member updated successfully');
  } catch (error) {
    console.error('Error updating project member:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to update project member' });
  }
});

// DELETE /projects/:projectId/members/:memberId
router.delete('/projects/:projectId/members/:memberId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const projectId = String(req.params.projectId);
    const memberId = String(req.params.memberId);
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    const project = await requireProjectOwner(projectId, userId, res);
    if (!project) return;

    const [deletedMember] = await db.delete(shootMembers)
      .where(and(eq(shootMembers.id, memberId), eq(shootMembers.projectId, projectId)))
      .returning();

    if (!deletedMember) {
      return sendError(res, 404, { code: 'NOT_FOUND', message: 'Member not found' });
    }

    return sendSuccess(res, 200, {}, 'Team member removed successfully');
  } catch (error) {
    console.error('Error deleting project member:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to delete project member' });
  }
});

// GET /team-members — fetch all team members for Quick Add Crew, homepage counts, and Circle view with availability
router.get('/team-members', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    const datesQuery = typeof req.query.dates === 'string' ? req.query.dates : ''; // e.g. "2026-07-16,2026-07-20"
    const targetDates = datesQuery ? datesQuery.split(',').map((d) => d.trim()).filter(isDateString).slice(0, 62) : [];

    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        phone: users.phone,
        firstLogin: users.firstLogin,
      })
      .from(teamMembers)
      .innerJoin(users, eq(teamMembers.memberId, users.id))
      .where(eq(teamMembers.userId, userId));

    const memberIds = rows.map((r) => r.id);
    let bookings: Array<{ userId: string | null; date: string; projectTitle: string; ownerId: string }> = [];

    if (memberIds.length > 0 && targetDates.length > 0) {
      // A circle member can be "busy" two different ways: booked as crew on
      // someone else's project (shootMembers), or running their own project
      // as the owner (projects.ownerId) — e.g. a shoot they booked directly
      // with a client, with no shootMembers row at all. Availability has to
      // check both, or a member's own bookings are invisible to everyone
      // else's Circle.
      const [crewBookings, ownedBookings] = await Promise.all([
        db
          .select({
            userId: shootMembers.userId,
            date: shootDays.date,
            projectTitle: projects.title,
            ownerId: projects.ownerId,
          })
          .from(shootMembers)
          .innerJoin(projects, eq(shootMembers.projectId, projects.id))
          .innerJoin(shootDays, eq(shootDays.projectId, projects.id))
          .where(
            and(
              inArray(shootMembers.userId, memberIds),
              inArray(shootDays.date, targetDates)
            )
          ),
        db
          .select({
            userId: projects.ownerId,
            date: shootDays.date,
            projectTitle: projects.title,
            ownerId: projects.ownerId,
          })
          .from(projects)
          .innerJoin(shootDays, eq(shootDays.projectId, projects.id))
          .where(
            and(
              inArray(projects.ownerId, memberIds),
              inArray(shootDays.date, targetDates)
            )
          ),
      ]);
      bookings = [...crewBookings, ...ownedBookings];
    }

    const result = rows.map((r) => {
      const userBookings = bookings.filter((b) => b.userId === r.id);
      const isAvailable = userBookings.length === 0;
      return {
        id: r.id,
        name: r.name,
        email: r.email,
        phone: r.phone,
        initials: getInitials(r.name || r.email),
        avatarColor: getAvatarColor(r.email),
        // Stored as smallint, defaulting to 1 ("first login still pending")
        // for every new/never-logged-in account — see the serializeUser()
        // comment in routes/auth.ts. So 0 → onboarded, 1 → not yet.
        firstLogin: r.firstLogin === 0,
        isAvailable: datesQuery ? isAvailable : undefined,
        // Only the date is shared. Someone's other bookings are their business:
        // the title is shown only when the booking is on the viewer's own shoot.
        busyOn: datesQuery && !isAvailable
          ? userBookings.map((b) => (b.ownerId === userId ? { date: b.date, projectTitle: b.projectTitle } : { date: b.date }))
          : undefined,
      };
    });

    return sendSuccess(res, 200, { teamMembers: result }, 'Team members fetched successfully');
  } catch (error) {
    console.error('Error fetching team members:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to fetch team members' });
  }
});

// DELETE /team-members/:memberId — remove a team member from the user's circle
router.delete('/team-members/:memberId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const memberId = String(req.params.memberId);
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    await db
      .delete(teamMembers)
      .where(and(eq(teamMembers.userId, userId), eq(teamMembers.memberId, memberId)));

    return sendSuccess(res, 200, {}, 'Team member removed from circle successfully');
  } catch (error) {
    console.error('Error removing team member from circle:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to remove team member from circle' });
  }
});

export default router;
