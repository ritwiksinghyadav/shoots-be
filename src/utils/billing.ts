import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { payments, users } from '../db/schema.js';
import { TERM_MONTHS, getEarlyAccessEnd, resolvePlan } from './plan.js';
import type { RazorpayPayment } from './razorpay.js';

/**
 * Payment state changes. Every one is a single SQL statement guarded by the
 * row's current status, so the checkout callback and the webhook (which
 * usually both arrive, in either order, sometimes more than once) can't apply
 * the same payment or refund twice. neon-http has no interactive
 * transactions; one statement with data-modifying CTEs is atomic on its own.
 */

export type PaymentRow = typeof payments.$inferSelect;

/**
 * Marks an order paid and adds a paid year to the account. The year starts
 * where the account's current Pro ends (paid, admin or early bird), so paying
 * early never loses days. Returns the row afterwards; a second call for the
 * same order changes nothing and returns the row as it already is.
 */
export async function markPaid(orderId: string, payment: RazorpayPayment): Promise<PaymentRow | null> {
  const [row] = await db.select().from(payments).where(eq(payments.orderId, orderId)).limit(1);
  if (!row) {
    console.error(`[billing] Captured payment ${payment.id} for unknown order ${orderId}`);
    return null;
  }
  if (row.status !== 'created' && row.status !== 'failed') return row;

  if (payment.amount !== row.amount || payment.currency !== row.currency) {
    // Never grant for a different amount than we asked for.
    console.error(`[billing] Payment ${payment.id} amount ${payment.amount} ${payment.currency} does not match order ${orderId} (${row.amount} ${row.currency})`);
    return row;
  }

  // The paid term isn't counted here: the statement below reads the live
  // paid_pro_until under a row lock, so two payments landing together stack.
  let otherTermsEnd: Date | null = null;
  if (row.userId) {
    const [user] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1);
    if (user) otherTermsEnd = resolvePlan({ ...user, paidProUntil: null }, await getEarlyAccessEnd()).proUntil;
  }

  await db.execute(sql`
    WITH u AS (
      SELECT id,
             GREATEST(now(), ${otherTermsEnd?.toISOString() ?? null}::timestamptz, paid_pro_until) AS start
      FROM users
      WHERE id = ${row.userId}
      FOR UPDATE
    ),
    p AS (
      UPDATE payments
      SET status = 'paid',
          payment_id = ${payment.id},
          method = ${payment.method ?? null},
          failure_reason = NULL,
          paid_at = now(),
          period_start = (SELECT start FROM u),
          period_end = (SELECT start FROM u) + make_interval(months => ${TERM_MONTHS.paid}),
          raw = ${JSON.stringify(payment)}::jsonb,
          updated_at = now()
      WHERE order_id = ${orderId} AND status IN ('created', 'failed')
      RETURNING user_id, period_end
    )
    UPDATE users
    SET paid_pro_until = p.period_end, updated_at = now()
    FROM p
    WHERE users.id = p.user_id
  `);

  const [after] = await db.select().from(payments).where(eq(payments.orderId, orderId)).limit(1);
  return after ?? null;
}

/** Records a failed attempt. A later successful attempt on the same order still goes through. */
export async function markFailed(orderId: string, payment: RazorpayPayment): Promise<void> {
  await db
    .update(payments)
    .set({
      status: 'failed',
      paymentId: payment.id,
      method: payment.method ?? null,
      failureReason: payment.error_description ?? 'Payment failed',
      raw: payment,
    })
    .where(sql`${payments.orderId} = ${orderId} AND ${payments.status} IN ('created', 'failed')`);
}

/**
 * Records a refund. `totalRefunded` is the payment's cumulative refunded
 * amount in paise (Razorpay's `amount_refunded`), so replays are no-ops. A
 * full refund takes the payment's months back off `paid_pro_until`; payments
 * stacked after it move earlier by the same amount, so nobody keeps a year
 * they didn't pay for. A partial refund is recorded but leaves Pro alone.
 */
export async function markRefunded(
  paymentId: string,
  totalRefunded: number,
  refundId: string | null,
  refundedBy: string | null,
): Promise<PaymentRow | null> {
  await db.execute(sql`
    WITH p AS (
      UPDATE payments
      SET status = CASE WHEN ${totalRefunded} >= amount THEN 'refunded' ELSE 'partially_refunded' END,
          amount_refunded = ${totalRefunded},
          refund_id = COALESCE(${refundId}, refund_id),
          refunded_at = COALESCE(refunded_at, now()),
          refunded_by = COALESCE(refunded_by, ${refundedBy}::uuid),
          updated_at = now()
      WHERE payment_id = ${paymentId}
        AND status IN ('paid', 'partially_refunded')
        AND ${totalRefunded} > amount_refunded
      RETURNING user_id, status, period_start, period_end
    )
    UPDATE users
    SET paid_pro_until = users.paid_pro_until - (p.period_end - p.period_start), updated_at = now()
    FROM p
    WHERE users.id = p.user_id AND p.status = 'refunded' AND users.paid_pro_until IS NOT NULL
  `);

  const [after] = await db.select().from(payments).where(eq(payments.paymentId, paymentId)).limit(1);
  return after ?? null;
}

/** What the app and admin panel show for one payment. `raw` stays server-side. */
export function serializePayment(p: PaymentRow) {
  return {
    id: p.id,
    orderId: p.orderId,
    paymentId: p.paymentId,
    amount: p.amount,
    currency: p.currency,
    status: p.status,
    method: p.method,
    periodStart: p.periodStart?.toISOString() ?? null,
    periodEnd: p.periodEnd?.toISOString() ?? null,
    paidAt: p.paidAt?.toISOString() ?? null,
    failureReason: p.failureReason,
    amountRefunded: p.amountRefunded,
    refundId: p.refundId,
    refundedAt: p.refundedAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
  };
}
