import { Router, Response } from 'express';
import { eq, and, or, asc, desc, inArray, ne, gte, lte, like, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { projects, shootDays, shootMembers, expenses, users, teamMembers } from '../db/schema.js';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { sendSuccess, sendError } from '../utils/response.js';
import { sendInvitationEmail } from '../utils/email.js';

const router = Router();

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
  team: {
    id: string;
    userId: string | null;
    name: string | null;
    email: string | null;
    payment: number;
    paymentStatus: string;
    invited: boolean;
  }[] = []
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
  };
}

/** Strip confidential financial and expense details from a project for a crew member */
function stripProjectForMember(project: ReturnType<typeof shapeProject>, userId: string) {
  return {
    ...project,
    budget: 0,
    expenses: [],
    team: project.team.map((member) => {
      // Keep own payment details, mask other crew members' financial details
      if (member.userId === userId) {
        return member;
      }
      return {
        ...member,
        payment: 0,
        paymentStatus: 'unpaid' as const,
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

/** Shape a shoot member row (with optional joined user fields) into the API shape. */
function shapeTeamMember(t: {
  id: string;
  userId: string | null;
  name: string | null;
  email: string | null;
  payment: number;
  paymentStatus: string;
  invited: boolean;
}) {
  const email = t.email ?? '';
  const name = t.name || null;
  return {
    id: t.id,
    userId: t.userId,
    name,
    email,
    initials: getInitials(name || email),
    payment: t.payment,
    paymentStatus: (t.paymentStatus === 'paid' ? 'paid' : 'unpaid') as 'paid' | 'unpaid',
    invited: t.invited,
    avatarColor: getAvatarColor(email),
  };
}

// Apply auth middleware to all project routes
router.use(requireAuth);

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
          ne(projects.status, 'done'),
          ne(projects.status, 'cancelled')
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
      return {
        shoot: {
          id: row.project.id,
          ownerId: row.project.ownerId,
          ownerName: row.ownerName || row.ownerEmail || row.project.ownerId,
          title: row.project.title,
          client: row.project.client,
          status: row.project.status,
          budget: row.project.budget,
          emoji: row.project.icon ?? '📸',
          notes: row.project.notes ?? '',
          category: 'editorial',
          coverColor: '#7C3AED',
          team: projectMembers.map(shapeTeamMember),
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
      return {
        shoot: {
          id: row.project.id,
          ownerId: row.project.ownerId,
          ownerName: row.ownerName || row.ownerEmail || row.project.ownerId,
          title: row.project.title,
          client: row.project.client,
          status: row.project.status,
          budget: row.project.budget,
          emoji: row.project.icon ?? '📸',
          notes: row.project.notes ?? '',
          category: 'editorial',
          coverColor: '#7C3AED',
          team: projectMembers.map(shapeTeamMember),
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
      WHERE p.owner_id = ${userId}::uuid
    `);

    // 2. Fetch expenses grouped by month for owned projects
    const expensesQuery = await db.execute(sql`
      SELECT 
        COALESCE(
          LEFT(e.date, 7),
          TO_CHAR(e.created_at, 'YYYY-MM')
        ) AS expense_month,
        SUM(e.amount)::integer AS total_amount
      FROM expenses e
      JOIN projects p ON e.project_id = p.id
      WHERE p.owner_id = ${userId}::uuid
      GROUP BY expense_month
    `);

    // 3. Fetch member projects: payment earnings grouped by project month
    const memberProjectsQuery = await db.execute(sql`
      SELECT 
        COALESCE(
          (SELECT LEFT(MIN(sd.date), 7) FROM shoot_days sd WHERE sd.project_id = p.id),
          TO_CHAR(p.created_at, 'YYYY-MM')
        ) AS project_month,
        SUM(sm.payment)::integer AS total_payment
      FROM shoot_members sm
      JOIN projects p ON sm.project_id = p.id
      WHERE sm.user_id = ${userId}::uuid
      GROUP BY project_month
    `);

    // 4. Fetch crew payouts: aggregated by crew member email
    const crewPayoutsQuery = await db.execute(sql`
      SELECT 
        LOWER(u.email) AS email,
        MAX(u.name) AS name,
        SUM(CASE WHEN sm.payment_status = 'paid' THEN sm.payment ELSE 0 END)::integer AS total_paid,
        SUM(CASE WHEN sm.payment_status != 'paid' THEN sm.payment ELSE 0 END)::integer AS total_unpaid
      FROM shoot_members sm
      JOIN projects p ON sm.project_id = p.id
      JOIN users u ON sm.user_id = u.id
      WHERE p.owner_id = ${userId}::uuid
      GROUP BY LOWER(u.email)
    `);

    // 5. Type definitions for raw SQL query results
    interface OwnedProjectRow { project_month: string; budget: number; crew_payouts: number }
    interface ExpenseRow { expense_month: string; total_amount: number }
    interface MemberProjectRow { project_month: string; total_payment: number }
    interface CrewPayoutRow { email: string; name: string; total_paid: number; total_unpaid: number }

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
        name,
        email,
        initials,
        avatarColor,
        totalPaid: Number(row.total_paid || 0),
        totalUnpaid: Number(row.total_unpaid || 0),
      };
    });

    return sendSuccess(res, 200, {
      timeSeries: Object.entries(monthlyData).map(([month, data]) => ({ month, ...data })),
      crewPayouts: crewPayoutsList,
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

    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
    const limit = 50;
    const offset = (page - 1) * limit;
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';

    // 1. Fetch owned projects (with optional search)
    const allOwnedProjects = await db
      .select()
      .from(projects)
      .where(eq(projects.ownerId, userId));

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
      .where(eq(shootMembers.userId, userId));

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
        budget: row.project.budget,
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

// POST /projects — create project + shoot days atomically
router.post('/projects', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    const { title, client, status, budget, icon, notes, shootDays: inputDays } = req.body;

    // ── Validation ────────────────────────────────────────────────────────
    const fields: Record<string, string> = {};
    if (!title || typeof title !== 'string' || !title.trim())
      fields.title = 'Title is required';
    if (!client || typeof client !== 'string' || !client.trim())
      fields.client = 'Client name is required';
    if (budget === undefined || budget === null || isNaN(Number(budget)) || Number(budget) < 0)
      fields.budget = 'A valid budget amount is required';
    if (!Array.isArray(inputDays) || inputDays.length === 0)
      fields.shootDays = 'At least one shoot day is required';
    else
      (inputDays as Array<{ date: string; time?: string; locationName?: string; notes?: string }>).forEach((day, i) => {
        if (!day.date) fields[`shootDays[${i}].date`] = `Shoot day ${i + 1}: date is required`;
      });

    if (Object.keys(fields).length > 0) {
      return sendError(res, 400, { code: 'VALIDATION_ERROR', message: 'Validation failed', fields });
    }

    // ── Insert project ────────────────────────────────────────────────────
    const [newProject] = await db
      .insert(projects)
      .values({
        ownerId: userId,
        title: title.trim(),
        client: client.trim(),
        status: status || 'inquiry',
        budget: Number(budget),
        icon: icon ?? null,
        notes: notes?.trim() ?? null,
      })
      .returning();

    // ── Insert shoot days ─────────────────────────────────────────────────
    const dayValues = (inputDays as Array<{ date: string; time?: string; locationName?: string; locationJSON?: object; shootOrder?: number; notes?: string }>).map((day, i) => ({
      projectId: newProject.id,
      date: day.date as string,
      time: (day.time ?? '') as string,
      locationJSON: {
        name: (day.locationName ?? '') as string,
        ...(day.locationName
          ? { mapsUrl: `https://maps.google.com/?q=${encodeURIComponent(day.locationName)}` }
          : {}),
      },
      shootOrder: i + 1,
      eventTitle: (day.notes ?? null) as string | null,
    }));

    const insertedDays = await db.insert(shootDays).values(dayValues).returning();

    // ── Fetch owner name & email ──────────────────────────────────────────
    const [owner] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, userId)).limit(1);

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
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const page = parseInt(req.query.page as string, 10) || 1;
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

    // 4. Shape
    const shaped = rows.map((r) => {
      const isOwner = r.project.ownerId === userId;
      let project = shapeProject(
        r.project,
        r.ownerName || r.ownerEmail || r.project.ownerId,
        r.ownerEmail || '',
        daysByProject.get(r.project.id) ?? [],
        expensesByProject.get(r.project.id) ?? [],
        membersByProject.get(r.project.id) ?? []
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
        paymentStatus: shootMembers.paymentStatus,
        invited: shootMembers.invited,
      })
      .from(shootMembers)
      .leftJoin(users, eq(shootMembers.userId, users.id))
      .where(eq(shootMembers.projectId, id));

    const isOwner = projectData.project.ownerId === userId;
    let shapedProject = shapeProject(
      projectData.project,
      projectData.ownerName || projectData.ownerEmail || projectData.project.ownerId,
      projectData.ownerEmail ?? '',
      days,
      exps,
      members
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

    const { title, client, status, budget, icon, notes } = req.body;

    // Validate required fields
    const fields: Record<string, string> = {};
    if (title !== undefined && (!title || typeof title !== 'string' || !title.trim()))
      fields.title = 'Title cannot be empty';
    if (client !== undefined && (!client || typeof client !== 'string' || !client.trim()))
      fields.client = 'Client cannot be empty';
    if (budget !== undefined && (isNaN(Number(budget)) || Number(budget) < 0))
      fields.budget = 'Budget must be a valid number';
    if (Object.keys(fields).length > 0)
      return sendError(res, 400, { code: 'VALIDATION_ERROR', message: 'Validation failed', fields });

    const [updatedProject] = await db
      .update(projects)
      .set({
        ...(title !== undefined && { title: title.trim() }),
        ...(client !== undefined && { client: client.trim() }),
        ...(status !== undefined && { status }),
        ...(budget !== undefined && { budget: Number(budget) }),
        ...(icon !== undefined && { icon }),
        ...(notes !== undefined && { notes: notes.trim() }),
        updatedAt: new Date(),
      })
      .where(and(eq(projects.id, id), eq(projects.ownerId, userId)))
      .returning();

    if (!updatedProject) {
      return sendError(res, 404, { code: 'NOT_FOUND', message: 'Project not found' });
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
        paymentStatus: shootMembers.paymentStatus,
        invited: shootMembers.invited,
      })
      .from(shootMembers)
      .leftJoin(users, eq(shootMembers.userId, users.id))
      .where(eq(shootMembers.projectId, id));

    return sendSuccess(
      res,
      200,
      { project: shapeProject(updatedProject, owner?.name ?? userId, owner?.email ?? '', days, exps, members) },
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

    const { date, time, locationJSON, shootOrder, eventTitle } = req.body;

    const [newDay] = await db.insert(shootDays).values({
      projectId,
      date,
      time,
      locationJSON: locationJSON || {},
      shootOrder: shootOrder || 1,
      eventTitle,
    }).returning();

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

    const { date, time, locationJSON, shootOrder, eventTitle } = req.body;

    const [updatedDay] = await db.update(shootDays)
      .set({
        date, time, locationJSON, shootOrder, eventTitle,
        updatedAt: new Date()
      })
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

    const { label, amount, category, date } = req.body;

    // Validation
    const fields: Record<string, string> = {};
    if (!label || typeof label !== 'string' || !label.trim()) {
      fields.label = 'Label is required';
    }
    if (amount === undefined || amount === null || isNaN(Number(amount)) || Number(amount) <= 0) {
      fields.amount = 'A valid positive amount is required';
    }

    if (Object.keys(fields).length > 0) {
      return sendError(res, 400, { code: 'VALIDATION_ERROR', message: 'Validation failed', fields });
    }

    const [newExpense] = await db.insert(expenses).values({
      projectId,
      label: label.trim(),
      amount: Number(amount),
      category: category || 'misc',
      date: date && typeof date === 'string' && date.trim() ? date.trim() : null,
    }).returning();

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

// ─── Team Members / Crew Endpoints ──────────────────────────────────────────

// POST /projects/:projectId/members
router.post('/projects/:projectId/members', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const projectId = String(req.params.projectId);
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    const project = await requireProjectOwner(projectId, userId, res);
    if (!project) return;

    // Fetch project owner and project shoot dates for the invitation email
    const [owner] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const ownerName = owner?.name || owner?.email || 'Someone';

    const days = await db
      .select({ date: shootDays.date })
      .from(shootDays)
      .where(eq(shootDays.projectId, projectId));
    const shootDates = days.map((d) => d.date);

    let emails: string[] = [];
    const { email, emails: bodyEmails, payment, paymentStatus, invited } = req.body;

    if (Array.isArray(bodyEmails)) {
      emails = bodyEmails;
    } else if (email && typeof email === 'string') {
      emails = [email];
    }

    if (emails.length === 0) {
      return sendError(res, 400, { code: 'BAD_REQUEST', message: 'Valid email or emails array is required' });
    }

    const results = [];

    for (const rawEmail of emails) {
      if (typeof rawEmail !== 'string' || !rawEmail.includes('@')) continue;
      const targetEmail = rawEmail.trim().toLowerCase();

      // 1. Search for user by email
      let [targetUser] = await db.select().from(users).where(eq(users.email, targetEmail)).limit(1);
      let isNewUser = false;

      if (!targetUser) {
        // 1.1 Create user if not in database
        const [newUser] = await db.insert(users).values({
          email: targetEmail,
          invitedBy: userId,
        }).returning();
        targetUser = newUser;
        isNewUser = true;
      }

      if (isNewUser) {
        sendInvitationEmail(targetEmail, ownerName, project.title, project.client, shootDates).catch((err) => {
          console.error(`Failed to send invitation email to ${targetEmail}:`, err);
        });
      }

      // 2. Check if already a member of this project
      const [existingMember] = await db.select().from(shootMembers).where(and(
        eq(shootMembers.projectId, projectId),
        eq(shootMembers.userId, targetUser.id)
      )).limit(1);

      if (existingMember) {
        continue;
      }

      // 3. Map user with project
      const [newMember] = await db.insert(shootMembers).values({
        projectId,
        userId: targetUser.id,
        payment: Number(payment) || 0,
        paymentStatus: paymentStatus === 'paid' ? 'paid' : 'unpaid',
        invited: invited !== undefined ? invited : true,
      }).returning();

      // 4. Add to owner's teamMembers list (if not already there)
      const [existingTeamMember] = await db.select().from(teamMembers).where(and(
        eq(teamMembers.userId, userId),
        eq(teamMembers.memberId, targetUser.id)
      )).limit(1);

      if (!existingTeamMember) {
        await db.insert(teamMembers).values({
          userId,
          memberId: targetUser.id,
        });
      }

      results.push(shapeTeamMember({
        id: newMember.id,
        userId: targetUser.id,
        name: targetUser.name || null,
        email: targetUser.email,
        payment: newMember.payment,
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

    const { payment, paymentStatus, invited } = req.body;

    const [updatedMember] = await db.update(shootMembers)
      .set({
        ...(payment !== undefined && { payment: Number(payment) }),
        ...(paymentStatus !== undefined && { paymentStatus }),
        ...(invited !== undefined && { invited }),
        updatedAt: new Date()
      })
      .where(and(eq(shootMembers.id, memberId), eq(shootMembers.projectId, projectId)))
      .returning();

    if (!updatedMember) {
      return sendError(res, 404, { code: 'NOT_FOUND', message: 'Member not found' });
    }

    // Fetch user details for response
    const [user] = await db.select({
      name: users.name,
      email: users.email,
    }).from(users).where(eq(users.id, updatedMember.userId!)).limit(1);

    const shapedMember = shapeTeamMember({
      id: updatedMember.id,
      userId: updatedMember.userId,
      name: user?.name || null,
      email: user?.email ?? '',
      payment: updatedMember.payment,
      paymentStatus: updatedMember.paymentStatus,
      invited: updatedMember.invited,
    });

    return sendSuccess(res, 200, { member: shapedMember }, 'Team member updated successfully');
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

    const datesQuery = req.query.dates as string; // comma-separated dates, e.g. "2026-07-16,2026-07-20"
    const targetDates = datesQuery ? datesQuery.split(',').map((d) => d.trim()).filter(Boolean) : [];

    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
      })
      .from(teamMembers)
      .innerJoin(users, eq(teamMembers.memberId, users.id))
      .where(eq(teamMembers.userId, userId));

    const memberIds = rows.map((r) => r.id);
    let bookings: Array<{ userId: string | null; date: string; projectTitle: string }> = [];

    if (memberIds.length > 0 && targetDates.length > 0) {
      bookings = await db
        .select({
          userId: shootMembers.userId,
          date: shootDays.date,
          projectTitle: projects.title,
        })
        .from(shootMembers)
        .innerJoin(projects, eq(shootMembers.projectId, projects.id))
        .innerJoin(shootDays, eq(shootDays.projectId, projects.id))
        .where(
          and(
            inArray(shootMembers.userId, memberIds),
            inArray(shootDays.date, targetDates)
          )
        );
    }

    const result = rows.map((r) => {
      const userBookings = bookings.filter((b) => b.userId === r.id);
      const isAvailable = userBookings.length === 0;
      return {
        id: r.id,
        name: r.name,
        email: r.email,
        initials: getInitials(r.name || r.email),
        avatarColor: getAvatarColor(r.email),
        isAvailable: datesQuery ? isAvailable : undefined,
        busyOn: datesQuery && !isAvailable ? userBookings.map((b) => ({ date: b.date, projectTitle: b.projectTitle })) : undefined,
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
