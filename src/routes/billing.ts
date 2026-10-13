import { Router, Request, Response } from 'express';
import { and, desc, eq, gte, ne } from 'drizzle-orm';
import { db } from '../db/index.js';
import { payments, users } from '../db/schema.js';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { sendSuccess, sendError } from '../utils/response.js';
import { PRO_CURRENCY, PRO_PRICE_PAISE, TERM_MONTHS } from '../utils/plan.js';
import { markFailed, markPaid, markRefunded, serializePayment } from '../utils/billing.js';
import {
  RazorpayError,
  capturePayment,
  createOrder,
  fetchPayment,
  razorpayConfigured,
  razorpayKeyId,
  verifyCheckoutSignature,
  verifyWebhookSignature,
  type RazorpayPayment,
} from '../utils/razorpay.js';

/**
 * Paid Pro: a one-time ₹799 payment for 12 months, no auto-renewal. See
 * docs/PLANS.md. The flow is:
 *   1. POST /billing/orders     creates a Razorpay order, stored as `created`
 *   2. the app opens Razorpay Checkout with that order
 *   3. POST /billing/verify     checks the checkout signature and grants Pro
 *   4. POST /billing/webhook    Razorpay's server-to-server copy of the same
 *      events. It grants Pro too, so a closed tab mid-payment still works,
 *      and it picks up refunds made from the Razorpay dashboard.
 */

const router = Router();

/** Reuse an unpaid order this recent instead of making a new one per click. */
const ORDER_REUSE_MS = 30 * 60 * 1000;

// POST /billing/orders — start a checkout for one year of Pro
router.post('/billing/orders', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!razorpayConfigured()) {
      return sendError(res, 503, { code: 'BILLING_UNAVAILABLE', message: 'Online payments are not available yet.' });
    }
    const userId = req.user!.userId;
    const [user] = await db
      .select({ id: users.id, email: users.email, name: users.name, phone: users.phone })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) return sendError(res, 404, { code: 'NOT_FOUND', message: 'User not found' });

    const [recent] = await db
      .select()
      .from(payments)
      .where(and(
        eq(payments.userId, userId),
        eq(payments.status, 'created'),
        eq(payments.amount, PRO_PRICE_PAISE),
        gte(payments.createdAt, new Date(Date.now() - ORDER_REUSE_MS)),
      ))
      .orderBy(desc(payments.createdAt))
      .limit(1);

    let order = recent;
    if (!order) {
      const rzp = await createOrder({
        amount: PRO_PRICE_PAISE,
        currency: PRO_CURRENCY,
        receipt: `pro_${userId.slice(0, 8)}_${Date.now().toString(36)}`,
        notes: { userId, email: user.email, plan: 'pro_yearly' },
      });
      [order] = await db
        .insert(payments)
        .values({ userId, email: user.email, orderId: rzp.id, amount: rzp.amount, currency: rzp.currency })
        .returning();
    }

    return sendSuccess(res, 201, {
      keyId: razorpayKeyId(),
      orderId: order.orderId,
      amount: order.amount,
      currency: order.currency,
      months: TERM_MONTHS.paid,
      prefill: { name: user.name ?? '', email: user.email, contact: user.phone ?? '' },
    }, 'Order created');
  } catch (error) {
    console.error('[billing] Create order error:', error);
    const message = error instanceof RazorpayError ? 'Could not start the payment. Please try again.' : 'An unexpected error occurred';
    return sendError(res, 502, { code: 'PAYMENT_PROVIDER_ERROR', message });
  }
});

// POST /billing/verify — called by the app when Checkout reports success
router.post('/billing/verify', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body ?? {};
    if (typeof orderId !== 'string' || typeof paymentId !== 'string' || typeof signature !== 'string') {
      return sendError(res, 400, { code: 'VALIDATION_ERROR', message: 'Payment details are missing' });
    }
    if (!verifyCheckoutSignature(orderId, paymentId, signature)) {
      return sendError(res, 400, { code: 'INVALID_SIGNATURE', message: 'Payment could not be verified' });
    }

    const [row] = await db.select().from(payments).where(eq(payments.orderId, orderId)).limit(1);
    if (!row || row.userId !== req.user!.userId) {
      return sendError(res, 404, { code: 'NOT_FOUND', message: 'Order not found' });
    }

    // The signature proves the pair is genuine; Razorpay's own record says
    // whether the money actually moved.
    let payment = await fetchPayment(paymentId);
    if (payment.order_id !== orderId) {
      return sendError(res, 400, { code: 'INVALID_PAYMENT', message: 'Payment does not belong to this order' });
    }
    if (payment.status === 'authorized') {
      payment = await capturePayment(paymentId, row.amount, row.currency);
    }
    if (payment.status !== 'captured') {
      // Still settling. The webhook finishes the job when it lands.
      return sendSuccess(res, 202, { payment: serializePayment(row) }, 'Payment is processing');
    }

    const after = await markPaid(orderId, payment);
    return sendSuccess(res, 200, { payment: after ? serializePayment(after) : null }, 'Payment successful');
  } catch (error) {
    console.error('[billing] Verify error:', error);
    return sendError(res, 502, {
      code: 'PAYMENT_PROVIDER_ERROR',
      message: 'We could not confirm your payment yet. If money was taken, Pro will turn on within a few minutes.',
    });
  }
});

// GET /billing/payments — the signed-in user's own payment history
router.get('/billing/payments', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const rows = await db
      .select()
      .from(payments)
      // Unpaid orders are abandoned checkouts, not history.
      .where(and(eq(payments.userId, req.user!.userId), ne(payments.status, 'created')))
      .orderBy(desc(payments.createdAt))
      .limit(50);
    return sendSuccess(res, 200, { items: rows.map(serializePayment) }, 'Payments fetched');
  } catch (error) {
    console.error('[billing] List payments error:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to fetch payments' });
  }
});

/**
 * POST /billing/webhook — mounted in index.ts with express.raw() ahead of
 * express.json(), because the signature covers the exact bytes Razorpay sent.
 * Answers 2xx for anything verified, even events it ignores, so Razorpay
 * doesn't retry them; 5xx only on a real failure, so it does.
 */
export async function razorpayWebhook(req: Request, res: Response) {
  const signature = req.get('x-razorpay-signature');
  if (!Buffer.isBuffer(req.body) || !signature || !verifyWebhookSignature(req.body, signature)) {
    return sendError(res, 400, { code: 'INVALID_SIGNATURE', message: 'Invalid webhook signature' });
  }

  try {
    const event = JSON.parse(req.body.toString('utf8')) as {
      event: string;
      payload: {
        payment?: { entity: RazorpayPayment };
        refund?: { entity: { id: string; payment_id: string } };
      };
    };
    const payment = event.payload.payment?.entity;

    switch (event.event) {
      case 'payment.captured':
      case 'order.paid':
        if (payment?.order_id && payment.status === 'captured') await markPaid(payment.order_id, payment);
        break;
      case 'payment.failed':
        if (payment?.order_id) await markFailed(payment.order_id, payment);
        break;
      case 'refund.created':
      case 'refund.processed': {
        const refund = event.payload.refund?.entity;
        if (!refund) break;
        // Read the live total rather than trust the snapshot in the event,
        // since refund events can arrive out of order.
        const current = await fetchPayment(refund.payment_id);
        await markRefunded(refund.payment_id, current.amount_refunded, refund.id, null);
        break;
      }
      default:
        break;
    }
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('[billing] Webhook error:', error);
    return sendError(res, 500, { code: 'INTERNAL_SERVER_ERROR', message: 'Webhook processing failed' });
  }
}

export default router;
