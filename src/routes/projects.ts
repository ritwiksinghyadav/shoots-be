import { Router, Response } from 'express';
import { eq, and, asc, inArray } from 'drizzle-orm';
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
  days: (typeof shootDays.$inferSelect)[]
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
    expenses: [],
    shootDays: days.map(shapeShootDay),
  };
}

// Apply auth middleware to all project routes
router.use(requireAuth);

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
      { project: shapeProject(newProject, owner?.name ?? userId, insertedDays) },
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

    // 4. Shape & return
    const shaped = rows.map((r) =>
      shapeProject(r.project, r.ownerName ?? userId, daysByProject.get(r.project.id) ?? [])
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

    // Fetch project
    const [projectData] = await db
      .select({
        project: projects,
        ownerName: users.name,
      })
      .from(projects)
      .innerJoin(users, eq(projects.ownerId, users.id))
      .where(and(eq(projects.id, id), eq(projects.ownerId, userId)))
      .limit(1);

    if (!projectData) {
      return sendError(res, 404, { code: 'NOT_FOUND', message: 'Project not found' });
    }

    // Fetch relations
    const days = await db.select().from(shootDays).where(eq(shootDays.projectId, id));
    const members = await db.select().from(shootMembers).where(eq(shootMembers.projectId, id));
    const projectExpenses = await db.select().from(expenses).where(eq(expenses.projectId, id));

    const result = {
      ...projectData.project,
      ownerName: projectData.ownerName,
      shootDays: days,
      team: members,
      expenses: projectExpenses,
    };

    return sendSuccess(res, 200, { project: result }, 'Project fetched successfully');
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

    const [updatedProject] = await db.update(projects)
      .set({
        title, client, status, budget, icon, notes,
        updatedAt: new Date(),
      })
      .where(and(eq(projects.id, id), eq(projects.ownerId, userId)))
      .returning();

    if (!updatedProject) {
      return sendError(res, 404, { code: 'NOT_FOUND', message: 'Project not found' });
    }

    return sendSuccess(res, 200, { project: updatedProject }, 'Project updated successfully');
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

export default router;
