import { Router, Response } from 'express';
import { eq, and, or, asc, desc, inArray, ne, gte, lte, like, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { projects, shootDays, shootMembers, expenses, users, teamMembers } from '../db/schema.js';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { sendSuccess, sendError } from '../utils/response.js';

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
    title: p.title,
    client: p.client,
    status: p.status,
    budget: p.budget,
    emoji: p.icon ?? '📸',
    notes: p.notes ?? '',
    category: 'editorial' as const,
    coverColor: '#7C3AED',
    team: team.map((t) => {
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
    }),
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
      })
      .from(shootDays)
      .innerJoin(projects, eq(shootDays.projectId, projects.id))
      .innerJoin(users, eq(projects.ownerId, users.id))
      .where(
        and(
          eq(projects.ownerId, userId),
          gte(shootDays.date, todayStr),
          lte(shootDays.date, oneMonthLaterStr),
          ne(projects.status, 'done'),
          ne(projects.status, 'cancelled')
        )
      )
      .orderBy(asc(shootDays.date), asc(shootDays.time));

    const result = rows.map((row) => {
      const shapedDay = shapeShootDay(row.shootDay);
      return {
        shoot: {
          id: row.project.id,
          ownerId: row.project.ownerId,
          ownerName: row.ownerName ?? userId,
          title: row.project.title,
          client: row.project.client,
          status: row.project.status,
          budget: row.project.budget,
          emoji: row.project.icon ?? '📸',
          notes: row.project.notes ?? '',
          category: 'editorial',
          coverColor: '#7C3AED',
          team: [],
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
      })
      .from(shootDays)
      .innerJoin(projects, eq(shootDays.projectId, projects.id))
      .innerJoin(users, eq(projects.ownerId, users.id))
      .where(
        and(
          eq(projects.ownerId, userId),
          like(shootDays.date, `${prefix}%`)
        )
      )
      .orderBy(asc(shootDays.date), asc(shootDays.time));

    const result = rows.map((row) => {
      const shapedDay = shapeShootDay(row.shootDay);
      return {
        shoot: {
          id: row.project.id,
          ownerId: row.project.ownerId,
          ownerName: row.ownerName ?? userId,
          title: row.project.title,
          client: row.project.client,
          status: row.project.status,
          budget: row.project.budget,
          emoji: row.project.icon ?? '📸',
          notes: row.project.notes ?? '',
          category: 'editorial',
          coverColor: '#7C3AED',
          team: [],
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
      (inputDays as any[]).forEach((day, i) => {
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
    const dayValues = (inputDays as any[]).map((day, i) => ({
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

    // ── Fetch owner name ──────────────────────────────────────────────────
    const [owner] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);

    return sendSuccess(
      res,
      201,
      { project: shapeProject(newProject, owner?.name ?? userId, insertedDays, [], []) },
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
      .select({ project: projects, ownerName: users.name })
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
    const shaped = rows.map((r) =>
      shapeProject(
        r.project,
        r.ownerName ?? userId,
        daysByProject.get(r.project.id) ?? [],
        expensesByProject.get(r.project.id) ?? [],
        membersByProject.get(r.project.id) ?? []
      )
    );

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
      .select({ project: projects, ownerName: users.name })
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
        .select({ project: projects, ownerName: users.name })
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

    return sendSuccess(
      res,
      200,
      { project: shapeProject(projectData.project, projectData.ownerName ?? userId, days, exps, members) },
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
      .select({ name: users.name })
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
      { project: shapeProject(updatedProject, owner?.name ?? userId, days, exps, members) },
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

    // Validate project ownership
    const [project] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.ownerId, userId))).limit(1);
    if (!project) return sendError(res, 404, { code: 'NOT_FOUND', message: 'Project not found' });

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

    // Validate project ownership
    const [project] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.ownerId, userId))).limit(1);
    if (!project) return sendError(res, 404, { code: 'NOT_FOUND', message: 'Project not found' });

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

    // Validate project ownership
    const [project] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.ownerId, userId))).limit(1);
    if (!project) return sendError(res, 404, { code: 'NOT_FOUND', message: 'Project not found' });

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

    // Validate project ownership
    const [project] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.ownerId, userId))).limit(1);
    if (!project) return sendError(res, 404, { code: 'NOT_FOUND', message: 'Project not found' });

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

    // Validate project ownership
    const [project] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.ownerId, userId))).limit(1);
    if (!project) return sendError(res, 404, { code: 'NOT_FOUND', message: 'Project not found' });

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

// ─── Team Members / Crew Endpoints ──────────────────────────────────────────

// POST /projects/:projectId/members
router.post('/projects/:projectId/members', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const projectId = String(req.params.projectId);
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    // Validate project ownership
    const [project] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.ownerId, userId))).limit(1);
    if (!project) return sendError(res, 404, { code: 'NOT_FOUND', message: 'Project not found' });

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

      if (!targetUser) {
        // 1.1 Create user if not in database
        const [newUser] = await db.insert(users).values({
          email: targetEmail,
          invitedBy: userId,
        }).returning();
        targetUser = newUser;
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

      results.push({
        id: newMember.id,
        userId: targetUser.id,
        name: targetUser.name || null,
        email: targetUser.email,
        initials: getInitials(targetUser.name || targetUser.email),
        payment: newMember.payment,
        paymentStatus: (newMember.paymentStatus === 'paid' ? 'paid' : 'unpaid') as 'paid' | 'unpaid',
        invited: newMember.invited,
        avatarColor: getAvatarColor(targetUser.email),
      });
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

    // Validate project ownership
    const [project] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.ownerId, userId))).limit(1);
    if (!project) return sendError(res, 404, { code: 'NOT_FOUND', message: 'Project not found' });

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

    const shapedMember = {
      id: updatedMember.id,
      userId: updatedMember.userId,
      name: user?.name || null,
      email: user?.email ?? '',
      initials: getInitials((user?.name || user?.email) ?? ''),
      payment: updatedMember.payment,
      paymentStatus: (updatedMember.paymentStatus === 'paid' ? 'paid' : 'unpaid') as 'paid' | 'unpaid',
      invited: updatedMember.invited,
      avatarColor: getAvatarColor(user?.email ?? ''),
    };

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

    // Validate project ownership
    const [project] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.ownerId, userId))).limit(1);
    if (!project) return sendError(res, 404, { code: 'NOT_FOUND', message: 'Project not found' });

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

// GET /team-members — fetch all team members for Quick Add Crew and homepage counts
router.get('/team-members', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
      })
      .from(teamMembers)
      .innerJoin(users, eq(teamMembers.memberId, users.id))
      .where(eq(teamMembers.userId, userId));

    const result = rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      initials: getInitials(r.name || r.email),
      avatarColor: getAvatarColor(r.email),
    }));

    return sendSuccess(res, 200, { teamMembers: result }, 'Team members fetched successfully');
  } catch (error) {
    console.error('Error fetching team members:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to fetch team members' });
  }
});

// DELETE /projects/:id
router.delete('/projects/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const id = String(req.params.id);
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    // Validate project ownership (only owner can delete)
    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.ownerId, userId)))
      .limit(1);

    if (!project) {
      return sendError(res, 404, { code: 'NOT_FOUND', message: 'Project not found or you are not the owner' });
    }

    // Delete the project (associated shootDays, shootMembers, and expenses will cascade delete automatically)
    await db.delete(projects).where(eq(projects.id, id));

    return sendSuccess(res, 200, {}, 'Project deleted successfully');
  } catch (error) {
    console.error('Error deleting project:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to delete project' });
  }
});

export default router;
