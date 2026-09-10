import { Router, Response } from 'express';
import { eq, and, or, desc, like, sql, ne, count } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, projects, shootDays, shootMembers, expenses, feedback } from '../db/schema.js';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { hashPassword } from '../utils/auth.js';
import { sendSuccess, sendError } from '../utils/response.js';
import { serializeUser } from './auth.js';

const router = Router();

router.use(requireAuth, requireAdmin);

const VALID_CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'AED', 'SGD', 'JPY', 'AUD', 'CAD', 'CHF', 'HKD', 'MYR', 'THB', 'NZD'];

// ─── Users ──────────────────────────────────────────────────────────────────

// GET /admin/users — search by name/email/businessName, paginated
router.get('/admin/users', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20);
    const offset = (page - 1) * limit;
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';

    const conditions = [];
    if (q) {
      const pattern = `%${q}%`;
      conditions.push(
        or(
          like(sql`lower(${users.name})`, pattern),
          like(sql`lower(${users.email})`, pattern),
          like(sql`lower(${users.businessName})`, pattern)
        )
      );
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [countResult] = await db.select({ count: count() }).from(users).where(where);
    const total = Number(countResult?.count ?? 0);
    const pages = Math.ceil(total / limit) || 1;

    const rows = await db
      .select()
      .from(users)
      .where(where)
      .orderBy(desc(users.createdAt))
      .limit(limit)
      .offset(offset);

    return sendSuccess(
      res,
      200,
      { items: rows.map(serializeUser), pagination: { total, page, limit, pages } },
      'Users fetched successfully'
    );
  } catch (error) {
    console.error('Error fetching admin users:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to fetch users' });
  }
});

// POST /admin/users — admin-provisioned account, password optional (like /auth/register)
router.post('/admin/users', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, email, password, businessName, role } = req.body;

    const fields: Record<string, string> = {};
    if (!name || typeof name !== 'string' || !name.trim()) fields.name = 'Name is required';
    if (!email || typeof email !== 'string' || !email.trim()) fields.email = 'Email is required';
    if (password !== undefined && password !== null) {
      if (typeof password !== 'string' || password.length < 8) fields.password = 'Password must be at least 8 characters';
    }
    if (role !== undefined && role !== 'user' && role !== 'admin') fields.role = 'Role must be "user" or "admin"';

    if (Object.keys(fields).length > 0) {
      return sendError(res, 400, { code: 'VALIDATION_ERROR', message: 'Validation failed', fields });
    }

    const cleanEmail = email.trim().toLowerCase();

    const [existingUser] = await db.select().from(users).where(eq(users.email, cleanEmail)).limit(1);
    if (existingUser) {
      return sendError(res, 409, { code: 'CONFLICT', message: 'An account with this email already exists' });
    }

    const passwordHash = password ? await hashPassword(password) : null;

    const [newUser] = await db
      .insert(users)
      .values({
        name: name.trim(),
        email: cleanEmail,
        passwordHash,
        businessName: businessName?.trim() || null,
        role: role || 'user',
      })
      .returning();

    return sendSuccess(res, 201, { user: serializeUser(newUser) }, 'User created successfully');
  } catch (error) {
    console.error('Error creating admin user:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create user' });
  }
});

// GET /admin/users/:id — detail, plus shoot/feedback counts
router.get('/admin/users/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!user) return sendError(res, 404, { code: 'NOT_FOUND', message: 'User not found' });

    const [[shootsOwned], [feedbackCount]] = await Promise.all([
      db.select({ count: count() }).from(projects).where(eq(projects.ownerId, id)),
      db.select({ count: count() }).from(feedback).where(eq(feedback.userId, id)),
    ]);

    return sendSuccess(
      res,
      200,
      {
        user: serializeUser(user),
        counts: {
          shootsOwned: Number(shootsOwned?.count ?? 0),
          feedbackSubmitted: Number(feedbackCount?.count ?? 0),
        },
      },
      'User fetched successfully'
    );
  } catch (error) {
    console.error('Error fetching admin user:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to fetch user' });
  }
});

// PUT /admin/users/:id — edit profile fields, role, verification, currency; optional password reset
router.put('/admin/users/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const { name, email, businessName, phone, occupation, role, isVerified, isPro, preferredCurrency, password } = req.body;

    const fields: Record<string, string> = {};
    if (name !== undefined && (!name || typeof name !== 'string' || !name.trim())) fields.name = 'Name cannot be empty';
    if (email !== undefined && (!email || typeof email !== 'string' || !email.trim())) fields.email = 'Email cannot be empty';
    if (role !== undefined && role !== 'user' && role !== 'admin') fields.role = 'Role must be "user" or "admin"';
    if (isVerified !== undefined && typeof isVerified !== 'boolean') fields.isVerified = 'isVerified must be a boolean';
    if (isPro !== undefined && typeof isPro !== 'boolean') fields.isPro = 'isPro must be a boolean';
    if (preferredCurrency !== undefined && !VALID_CURRENCIES.includes(preferredCurrency)) fields.preferredCurrency = 'Invalid currency code';
    if (password !== undefined && password !== null && (typeof password !== 'string' || password.length < 8)) {
      fields.password = 'Password must be at least 8 characters';
    }

    if (Object.keys(fields).length > 0) {
      return sendError(res, 400, { code: 'VALIDATION_ERROR', message: 'Validation failed', fields });
    }

    type UserUpdateData = Partial<
      Pick<typeof users.$inferInsert, 'name' | 'email' | 'businessName' | 'phone' | 'occupation' | 'role' | 'isVerified' | 'isPro' | 'preferredCurrency' | 'passwordHash'>
    > & { updatedAt: Date };
    const updatePayload: UserUpdateData = { updatedAt: new Date() };

    if (name !== undefined) updatePayload.name = name.trim();
    if (businessName !== undefined) updatePayload.businessName = businessName?.trim() || null;
    if (phone !== undefined) updatePayload.phone = phone?.trim() || null;
    if (occupation !== undefined) updatePayload.occupation = occupation?.trim() || null;
    if (role !== undefined) updatePayload.role = role;
    if (isVerified !== undefined) updatePayload.isVerified = isVerified;
    if (isPro !== undefined) updatePayload.isPro = isPro;
    if (preferredCurrency !== undefined) updatePayload.preferredCurrency = preferredCurrency;

    if (email !== undefined) {
      const cleanEmail = email.trim().toLowerCase();
      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, cleanEmail), ne(users.id, id)))
        .limit(1);
      if (existing) {
        return sendError(res, 409, { code: 'CONFLICT', message: 'An account with this email already exists' });
      }
      updatePayload.email = cleanEmail;
    }

    if (password !== undefined && password !== null) {
      updatePayload.passwordHash = await hashPassword(password);
    }

    const [updatedUser] = await db.update(users).set(updatePayload).where(eq(users.id, id)).returning();
    if (!updatedUser) return sendError(res, 404, { code: 'NOT_FOUND', message: 'User not found' });

    return sendSuccess(res, 200, { user: serializeUser(updatedUser) }, 'User updated successfully');
  } catch (error) {
    console.error('Error updating admin user:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to update user' });
  }
});

// DELETE /admin/users/:id — FK onDelete: 'cascade' removes their owned projects/expenses/etc.
router.delete('/admin/users/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const [deletedUser] = await db.delete(users).where(eq(users.id, id)).returning();
    if (!deletedUser) return sendError(res, 404, { code: 'NOT_FOUND', message: 'User not found' });
    return sendSuccess(res, 200, {}, 'User deleted successfully');
  } catch (error) {
    console.error('Error deleting admin user:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to delete user' });
  }
});

// GET /admin/users/:id/shoots — that user's owned projects
router.get('/admin/users/:id/shoots', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const rows = await db
      .select()
      .from(projects)
      .where(eq(projects.ownerId, id))
      .orderBy(desc(projects.createdAt));

    return sendSuccess(
      res,
      200,
      {
        items: rows.map((p) => ({
          id: p.id,
          title: p.title,
          client: p.client,
          status: p.status,
          budget: p.budget,
          createdAt: p.createdAt,
        })),
      },
      "User's shoots fetched successfully"
    );
  } catch (error) {
    console.error("Error fetching user's shoots:", error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: "Failed to fetch user's shoots" });
  }
});

// ─── Shoots (global project CRUD) ──────────────────────────────────────────

// GET /admin/shoots — global list, joined with owner name/email
router.get('/admin/shoots', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20);
    const offset = (page - 1) * limit;
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';

    const conditions = [];
    if (q) {
      const pattern = `%${q}%`;
      conditions.push(
        or(
          like(sql`lower(${projects.title})`, pattern),
          like(sql`lower(${projects.client})`, pattern),
          like(sql`lower(${users.name})`, pattern),
          like(sql`lower(${users.email})`, pattern)
        )
      );
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [countResult] = await db
      .select({ count: count() })
      .from(projects)
      .innerJoin(users, eq(projects.ownerId, users.id))
      .where(where);
    const total = Number(countResult?.count ?? 0);
    const pages = Math.ceil(total / limit) || 1;

    const rows = await db
      .select({ project: projects, ownerName: users.name, ownerEmail: users.email })
      .from(projects)
      .innerJoin(users, eq(projects.ownerId, users.id))
      .where(where)
      .orderBy(desc(projects.createdAt))
      .limit(limit)
      .offset(offset);

    return sendSuccess(
      res,
      200,
      {
        items: rows.map((r) => ({
          id: r.project.id,
          title: r.project.title,
          client: r.project.client,
          status: r.project.status,
          budget: r.project.budget,
          ownerId: r.project.ownerId,
          ownerName: r.ownerName,
          ownerEmail: r.ownerEmail,
          createdAt: r.project.createdAt,
        })),
        pagination: { total, page, limit, pages },
      },
      'Shoots fetched successfully'
    );
  } catch (error) {
    console.error('Error fetching admin shoots:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to fetch shoots' });
  }
});

// GET /admin/shoots/:id — full detail (owner, days, team, expenses) for context
router.get('/admin/shoots/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const [row] = await db
      .select({ project: projects, ownerName: users.name, ownerEmail: users.email })
      .from(projects)
      .innerJoin(users, eq(projects.ownerId, users.id))
      .where(eq(projects.id, id))
      .limit(1);

    if (!row) return sendError(res, 404, { code: 'NOT_FOUND', message: 'Shoot not found' });

    const [days, team, exps] = await Promise.all([
      db.select().from(shootDays).where(eq(shootDays.projectId, id)).orderBy(shootDays.shootOrder),
      db
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
        .where(eq(shootMembers.projectId, id)),
      db.select().from(expenses).where(eq(expenses.projectId, id)),
    ]);

    return sendSuccess(
      res,
      200,
      {
        shoot: {
          id: row.project.id,
          title: row.project.title,
          client: row.project.client,
          status: row.project.status,
          budget: row.project.budget,
          notes: row.project.notes ?? '',
          productionStage: row.project.productionStage,
          ownerId: row.project.ownerId,
          ownerName: row.ownerName,
          ownerEmail: row.ownerEmail,
          createdAt: row.project.createdAt,
          shootDays: days.map((d) => ({ id: d.id, date: d.date, time: d.time, location: d.locationJSON })),
          team: team.map((t) => ({ id: t.id, name: t.name, email: t.email, payment: t.payment, paymentStatus: t.paymentStatus, invited: t.invited })),
          expenses: exps.map((e) => ({ id: e.id, label: e.label, amount: e.amount, category: e.category })),
        },
      },
      'Shoot fetched successfully'
    );
  } catch (error) {
    console.error('Error fetching admin shoot:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to fetch shoot' });
  }
});

// PUT /admin/shoots/:id — same field set as the owner-scoped version, no ownerId filter
router.put('/admin/shoots/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const { title, client, status, budget, notes, productionStage } = req.body;

    const fields: Record<string, string> = {};
    if (title !== undefined && (!title || typeof title !== 'string' || !title.trim())) fields.title = 'Title cannot be empty';
    if (client !== undefined && (!client || typeof client !== 'string' || !client.trim())) fields.client = 'Client cannot be empty';
    if (budget !== undefined && (isNaN(Number(budget)) || Number(budget) < 0)) fields.budget = 'Budget must be a valid number';
    if (productionStage !== undefined && (!productionStage || typeof productionStage !== 'string' || !productionStage.trim())) {
      fields.productionStage = 'Stage cannot be empty';
    }
    if (Object.keys(fields).length > 0) {
      return sendError(res, 400, { code: 'VALIDATION_ERROR', message: 'Validation failed', fields });
    }

    const [updatedProject] = await db
      .update(projects)
      .set({
        ...(title !== undefined && { title: title.trim() }),
        ...(client !== undefined && { client: client.trim() }),
        ...(status !== undefined && { status }),
        ...(budget !== undefined && { budget: Number(budget) }),
        ...(notes !== undefined && { notes: notes.trim() }),
        ...(productionStage !== undefined && { productionStage: productionStage.trim() }),
        updatedAt: new Date(),
      })
      .where(eq(projects.id, id))
      .returning();

    if (!updatedProject) return sendError(res, 404, { code: 'NOT_FOUND', message: 'Shoot not found' });

    return sendSuccess(res, 200, { shoot: updatedProject }, 'Shoot updated successfully');
  } catch (error) {
    console.error('Error updating admin shoot:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to update shoot' });
  }
});

// DELETE /admin/shoots/:id
router.delete('/admin/shoots/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const [deleted] = await db.delete(projects).where(eq(projects.id, id)).returning();
    if (!deleted) return sendError(res, 404, { code: 'NOT_FOUND', message: 'Shoot not found' });
    return sendSuccess(res, 200, {}, 'Shoot deleted successfully');
  } catch (error) {
    console.error('Error deleting admin shoot:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to delete shoot' });
  }
});

// ─── Feedback (global CRUD) ─────────────────────────────────────────────────

// GET /admin/feedback — joined with submitter name/email, filterable by type/userId
router.get('/admin/feedback', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20);
    const offset = (page - 1) * limit;
    const { type, userId } = req.query;

    const conditions = [];
    if (type && typeof type === 'string' && type !== 'all') conditions.push(eq(feedback.type, type));
    if (userId && typeof userId === 'string') conditions.push(eq(feedback.userId, userId));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [countResult] = await db.select({ count: count() }).from(feedback).where(where);
    const total = Number(countResult?.count ?? 0);
    const pages = Math.ceil(total / limit) || 1;

    const rows = await db
      .select({
        id: feedback.id,
        type: feedback.type,
        message: feedback.message,
        createdAt: feedback.createdAt,
        userId: feedback.userId,
        userName: users.name,
        userEmail: users.email,
      })
      .from(feedback)
      .innerJoin(users, eq(feedback.userId, users.id))
      .where(where)
      .orderBy(desc(feedback.createdAt))
      .limit(limit)
      .offset(offset);

    return sendSuccess(res, 200, { items: rows, pagination: { total, page, limit, pages } }, 'Feedback fetched successfully');
  } catch (error) {
    console.error('Error fetching admin feedback:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to fetch feedback' });
  }
});

// GET /admin/feedback/:id
router.get('/admin/feedback/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const [row] = await db
      .select({
        id: feedback.id,
        type: feedback.type,
        message: feedback.message,
        createdAt: feedback.createdAt,
        userId: feedback.userId,
        userName: users.name,
        userEmail: users.email,
      })
      .from(feedback)
      .innerJoin(users, eq(feedback.userId, users.id))
      .where(eq(feedback.id, id))
      .limit(1);

    if (!row) return sendError(res, 404, { code: 'NOT_FOUND', message: 'Feedback not found' });
    return sendSuccess(res, 200, { feedback: row }, 'Feedback fetched successfully');
  } catch (error) {
    console.error('Error fetching admin feedback item:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to fetch feedback' });
  }
});

// PUT /admin/feedback/:id
router.put('/admin/feedback/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const { type, message } = req.body;

    const fields: Record<string, string> = {};
    if (type !== undefined && type !== 'feedback' && type !== 'bug') fields.type = 'Type must be "feedback" or "bug"';
    if (message !== undefined && (typeof message !== 'string' || !message.trim())) fields.message = 'Message cannot be empty';
    if (Object.keys(fields).length > 0) {
      return sendError(res, 400, { code: 'VALIDATION_ERROR', message: 'Validation failed', fields });
    }

    const [updated] = await db
      .update(feedback)
      .set({
        ...(type !== undefined && { type }),
        ...(message !== undefined && { message: message.trim() }),
      })
      .where(eq(feedback.id, id))
      .returning();

    if (!updated) return sendError(res, 404, { code: 'NOT_FOUND', message: 'Feedback not found' });
    return sendSuccess(res, 200, { feedback: updated }, 'Feedback updated successfully');
  } catch (error) {
    console.error('Error updating admin feedback:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to update feedback' });
  }
});

// DELETE /admin/feedback/:id
router.delete('/admin/feedback/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const [deleted] = await db.delete(feedback).where(eq(feedback.id, id)).returning();
    if (!deleted) return sendError(res, 404, { code: 'NOT_FOUND', message: 'Feedback not found' });
    return sendSuccess(res, 200, {}, 'Feedback deleted successfully');
  } catch (error) {
    console.error('Error deleting admin feedback:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to delete feedback' });
  }
});

export default router;
