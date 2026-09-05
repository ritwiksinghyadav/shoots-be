import { Router, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { projects, shootDays, shootMembers, shootMilestones, users } from '../db/schema.js';
import { sendSuccess, sendError } from '../utils/response.js';

const router = Router();

function getInitials(nameOrEmail: string) {
  const clean = nameOrEmail.split('@')[0].trim();
  const parts = clean.split(/[\s._-]+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}

const AVATAR_COLORS = [
  '#7C3AED', '#0284C7', '#059669', '#DB2777', '#EA580C', '#2563EB', '#D97706', '#4F46E5',
];

function getAvatarColor(email: string) {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = email.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

// GET /public/shoot/:token — unauthenticated, read-only. Deliberately a much
// smaller shape than the authenticated project endpoints: no budget,
// expenses, crew payment amounts, crew contact details, or owner's private
// project notes. This is the one route in the app that anyone with the link
// can hit with no login at all, so it only returns what's safe for a client
// (or anyone they forward the link to) to see.
router.get('/public/shoot/:token', async (req, res: Response) => {
  try {
    const token = String(req.params.token);

    const [projectData] = await db
      .select({ project: projects, ownerName: users.name, ownerBusinessName: users.businessName })
      .from(projects)
      .innerJoin(users, eq(projects.ownerId, users.id))
      .where(eq(projects.shareToken, token))
      .limit(1);

    if (!projectData || !projectData.project.shareEnabled) {
      return sendError(res, 404, { code: 'NOT_FOUND', message: 'This share link is invalid or no longer active.' });
    }

    const { project } = projectData;

    const days = await db
      .select()
      .from(shootDays)
      .where(eq(shootDays.projectId, project.id))
      .orderBy(shootDays.shootOrder);

    const milestones = await db
      .select()
      .from(shootMilestones)
      .where(eq(shootMilestones.projectId, project.id));

    const members = await db
      .select({ name: users.name, email: users.email })
      .from(shootMembers)
      .innerJoin(users, eq(shootMembers.userId, users.id))
      .where(eq(shootMembers.projectId, project.id));

    return sendSuccess(
      res,
      200,
      {
        shoot: {
          title: project.title,
          client: project.client,
          emoji: project.icon ?? '📸',
          productionStage: project.productionStage,
          ownerName: projectData.ownerName || 'Your photographer',
          ownerBusinessName: projectData.ownerBusinessName ?? null,
          shootDays: days.map((d) => ({
            date: d.date,
            time: d.time,
            location: d.locationJSON as { name: string; mapsUrl?: string },
            notes: d.eventTitle ?? undefined,
          })),
          milestones: milestones
            .slice()
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .map((m) => ({
              stage: m.stage,
              note: m.note ?? undefined,
              date: m.date ?? undefined,
              createdAt: m.createdAt.toISOString(),
            })),
          team: members.map((m) => {
            const name = m.name || m.email.split('@')[0];
            return { name, initials: getInitials(name), avatarColor: getAvatarColor(m.email) };
          }),
        },
      },
      'Shared shoot fetched successfully'
    );
  } catch (error) {
    console.error('Error fetching public shoot:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to fetch shared shoot' });
  }
});

export default router;
