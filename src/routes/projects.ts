import { Router, Response } from 'express';
import { eq, and, asc, inArray, ne, gte, lte, like } from 'drizzle-orm';
import { db } from '../db/index.js';
import { projects, shootDays, shootMembers, expenses, users } from '../db/schema.js';
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

function shapeProject(
  p: typeof projects.$inferSelect,
  ownerName: string,
  days: (typeof shootDays.$inferSelect)[],
  exps: (typeof expenses.$inferSelect)[] = []
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
    // Stubs for features not yet in DB
    category: 'editorial' as const,
    coverColor: '#7C3AED',
    team: [],
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
      { project: shapeProject(newProject, owner?.name ?? userId, insertedDays, []) },
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

    // 1. Fetch projects + owner name
    const rows = await db
      .select({ project: projects, ownerName: users.name })
      .from(projects)
      .innerJoin(users, eq(projects.ownerId, users.id))
      .where(eq(projects.ownerId, userId));

    if (rows.length === 0) {
      return sendSuccess(res, 200, { projects: [] }, 'Projects fetched successfully');
    }

    // 2. Fetch all shoot days for those projects in one query
    const projectIds = rows.map((r) => r.project.id);
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

    // 4. Shape & return
    const shaped = rows.map((r) =>
      shapeProject(
        r.project,
        r.ownerName ?? userId,
        daysByProject.get(r.project.id) ?? [],
        expensesByProject.get(r.project.id) ?? []
      )
    );

    return sendSuccess(res, 200, { projects: shaped }, 'Projects fetched successfully');
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

    const [projectData] = await db
      .select({ project: projects, ownerName: users.name })
      .from(projects)
      .innerJoin(users, eq(projects.ownerId, users.id))
      .where(and(eq(projects.id, id), eq(projects.ownerId, userId)))
      .limit(1);

    if (!projectData) {
      return sendError(res, 404, { code: 'NOT_FOUND', message: 'Project not found' });
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

    return sendSuccess(
      res,
      200,
      { project: shapeProject(projectData.project, projectData.ownerName ?? userId, days, exps) },
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

    return sendSuccess(
      res,
      200,
      { project: shapeProject(updatedProject, owner?.name ?? userId, days, exps) },
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

// DELETE /projects/:projectId/expenses/:expenseId
router.delete('/projects/:projectId/expenses/:expenseId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const projectId = String(req.params.projectId);
    const expenseId = String(req.params.expenseId);
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    // Validate project ownership
    const [project] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.ownerId, userId))).limit(1);
    if (!project) return sendError(res, 404, { code: 'NOT_FOUND', message: 'Project not found' });

    const [deletedExpense] = await db.delete(expenses)
      .where(and(eq(expenses.id, expenseId), eq(expenses.projectId, projectId)))
      .returning();

    if (!deletedExpense) return sendError(res, 404, { code: 'NOT_FOUND', message: 'Expense not found' });

    return sendSuccess(res, 200, {}, 'Expense deleted successfully');
  } catch (error) {
    console.error('Error deleting expense:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to delete expense' });
  }
});

export default router;
