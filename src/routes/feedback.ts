import { Router, Response } from 'express';
import { eq, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { feedback } from '../db/schema.js';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { sendSuccess, sendError } from '../utils/response.js';

const router = Router();
router.use(requireAuth);

const FEEDBACK_TYPES = ['feedback', 'bug'] as const;
type FeedbackType = (typeof FEEDBACK_TYPES)[number];

// Rolling 24h window rather than calendar-day: a calendar-day reset lets
// someone submit at 11:59pm and again at 12:01am, two minutes apart, which
// defeats the point of a "1 per day" cap.
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MIN_MESSAGE_LENGTH = 5;
const MAX_MESSAGE_LENGTH = 2000;

function shapeFeedback(row: typeof feedback.$inferSelect) {
  return { id: row.id, type: row.type, message: row.message, createdAt: row.createdAt };
}

async function getCooldownStatus(userId: string) {
  const [last] = await db
    .select({ createdAt: feedback.createdAt })
    .from(feedback)
    .where(eq(feedback.userId, userId))
    .orderBy(desc(feedback.createdAt))
    .limit(1);

  if (!last) return { canSubmit: true, nextAvailableAt: null as string | null, lastSubmittedAt: null as string | null };

  const nextAvailableAt = new Date(last.createdAt.getTime() + COOLDOWN_MS);
  const canSubmit = Date.now() >= nextAvailableAt.getTime();
  return {
    canSubmit,
    nextAvailableAt: canSubmit ? null : nextAvailableAt.toISOString(),
    lastSubmittedAt: last.createdAt.toISOString(),
  };
}

// GET /feedback/status — lets the client disable the submit button proactively
// instead of only finding out about the cooldown after a failed POST.
router.get('/feedback/status', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    const status = await getCooldownStatus(userId);
    return sendSuccess(res, 200, status, 'Feedback status fetched');
  } catch (error) {
    console.error('Error fetching feedback status:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to fetch feedback status' });
  }
});

// POST /feedback
router.post('/feedback', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return sendError(res, 401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

    const { type, message } = req.body;

    // ── Validation ────────────────────────────────────────────────────────
    const fields: Record<string, string> = {};
    const normalizedType: FeedbackType = FEEDBACK_TYPES.includes(type) ? type : 'feedback';
    if (type !== undefined && !FEEDBACK_TYPES.includes(type)) {
      fields.type = 'Type must be "feedback" or "bug"';
    }

    const trimmedMessage = typeof message === 'string' ? message.trim() : '';
    if (trimmedMessage.length < MIN_MESSAGE_LENGTH) {
      fields.message = `Message must be at least ${MIN_MESSAGE_LENGTH} characters`;
    } else if (trimmedMessage.length > MAX_MESSAGE_LENGTH) {
      fields.message = `Message must be under ${MAX_MESSAGE_LENGTH} characters`;
    }

    if (Object.keys(fields).length > 0) {
      return sendError(res, 400, { code: 'VALIDATION_ERROR', message: 'Validation failed', fields });
    }

    // ── Rate limit: 1 submission per rolling 24h window ─────────────────────
    const status = await getCooldownStatus(userId);
    if (!status.canSubmit) {
      return sendError(res, 429, {
        code: 'RATE_LIMITED',
        message: "You've already sent feedback in the last 24 hours. Please try again later.",
      });
    }

    const [created] = await db
      .insert(feedback)
      .values({ userId, type: normalizedType, message: trimmedMessage })
      .returning();

    return sendSuccess(res, 201, { feedback: shapeFeedback(created) }, 'Feedback submitted successfully');
  } catch (error) {
    console.error('Error submitting feedback:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to submit feedback' });
  }
});

export default router;
