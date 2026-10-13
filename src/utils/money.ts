import { eq, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { db } from '../db/index.js';
import { clientPayments, crewPayouts, shootMembers } from '../db/schema.js';
import { isDateString, isOptionalText, parseMoney } from './validate.js';

/**
 * Part payments. Money in from the client (`client_payments`) and money out to
 * crew (`crew_payouts`) are logged one row per payment; the running totals on
 * `projects.amount_received` and `shoot_members.amount_paid`, and the statuses
 * derived from them, are recomputed from those rows by the same transaction
 * that changes them, so they can't drift.
 */

export const PAYMENT_METHODS = ['upi', 'cash', 'bank', 'card', 'cheque', 'other'] as const;

/** Amount / date / method / note for one payment, as both routes accept it. */
export function validatePaymentEntry(body: Record<string, unknown>) {
  const fields: Record<string, string> = {};
  const amount = parseMoney(body.amount, { allowZero: false });
  if (amount === null) fields.amount = 'Enter a whole amount greater than 0';
  if (!isDateString(body.date)) fields.date = 'Date must be YYYY-MM-DD';
  if (body.method !== undefined && body.method !== null && body.method !== '' &&
      !(PAYMENT_METHODS as readonly string[]).includes(body.method as string)) {
    fields.method = 'Method must be UPI, cash, bank, card, cheque or other';
  }
  if (!isOptionalText(body.note, 200)) fields.note = 'Note can be up to 200 characters';
  return {
    fields,
    value: {
      amount: amount ?? 0,
      date: body.date as string,
      method: typeof body.method === 'string' && body.method ? body.method : null,
      note: typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null,
    },
  };
}

/**
 * Recomputes a project's received total and moves its status with the money:
 * paid in full → 'paid'; no longer in full after a payment is removed → back
 * to 'booked'; the first money in on an inquiry → 'booked'. A status the owner
 * set by hand is otherwise left alone.
 */
export function recomputeProject(projectId: string) {
  return db.execute(sql`
    UPDATE projects p
    SET amount_received = s.total,
        status = CASE
          WHEN p.budget > 0 AND s.total >= p.budget THEN 'paid'
          WHEN p.status = 'paid' AND s.total > 0 AND s.total < p.budget THEN 'booked'
          WHEN p.status = 'inquiry' AND s.total > 0 THEN 'booked'
          ELSE p.status
        END,
        updated_at = now()
    FROM (SELECT COALESCE(SUM(amount), 0)::int AS total FROM client_payments WHERE project_id = ${projectId}::uuid) s
    WHERE p.id = ${projectId}::uuid`);
}

/**
 * Recomputes a crew member's paid total and status from their payouts.
 * A ₹0 fee keeps whatever 'paid'/'unpaid' was set by hand.
 */
export function recomputeMember(memberId: string) {
  return db.execute(sql`
    UPDATE shoot_members m
    SET amount_paid = s.total,
        payment_status = CASE
          WHEN m.payment = 0 THEN CASE WHEN m.payment_status = 'paid' THEN 'paid' ELSE 'unpaid' END
          WHEN s.total >= m.payment THEN 'paid'
          WHEN s.total > 0 THEN 'partial'
          ELSE 'unpaid'
        END,
        updated_at = now()
    FROM (SELECT COALESCE(SUM(amount), 0)::int AS total FROM crew_payouts WHERE shoot_member_id = ${memberId}::uuid) s
    WHERE m.id = ${memberId}::uuid`);
}

type MemberRow = { id: string; payment: number; amountPaid: number; paymentStatus: string };

/**
 * Statements that apply a fee and/or status change to one crew member, kept
 * compatible with the old Paid/Unpaid toggle:
 *  - 'paid'   records one payout for whatever is still owed (today, "Marked as paid")
 *  - 'unpaid' clears this member's payouts
 * Status is then recomputed from the payouts. Returns an error message instead
 * when the change can't apply (e.g. a fee below what's already been paid).
 */
export function memberChange(
  member: MemberRow,
  change: { payment?: unknown; paymentStatus?: unknown },
): { error: string } | { statements: BatchItem<'pg'>[] } {
  const fee = change.payment !== undefined ? parseMoney(change.payment)! : member.payment;
  if (fee < member.amountPaid) {
    return { error: `The fee can't be less than the ${member.amountPaid} already paid. Remove a payout first.` };
  }

  const statements: BatchItem<'pg'>[] = [];
  if (change.payment !== undefined && fee !== member.payment) {
    statements.push(db.update(shootMembers).set({ payment: fee, updatedAt: new Date() }).where(eq(shootMembers.id, member.id)));
  }

  if (change.paymentStatus === 'paid') {
    if (fee === 0) {
      statements.push(db.update(shootMembers).set({ paymentStatus: 'paid' }).where(eq(shootMembers.id, member.id)));
    } else if (fee > member.amountPaid) {
      statements.push(db.insert(crewPayouts).values({
        shootMemberId: member.id,
        amount: fee - member.amountPaid,
        date: todayInIndia(),
        note: member.amountPaid > 0 ? 'Remaining balance' : 'Marked as paid',
      }));
    }
  } else if (change.paymentStatus === 'unpaid') {
    statements.push(db.delete(crewPayouts).where(eq(crewPayouts.shootMemberId, member.id)));
    if (fee === 0) statements.push(db.update(shootMembers).set({ paymentStatus: 'unpaid' }).where(eq(shootMembers.id, member.id)));
  }

  statements.push(recomputeMember(member.id));
  return { statements };
}

/** Today's date in India as YYYY-MM-DD, matching how the app records dates. */
export function todayInIndia() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

export function shapeClientPayment(p: typeof clientPayments.$inferSelect) {
  return { id: p.id, amount: p.amount, date: p.date, method: p.method, note: p.note, createdAt: p.createdAt.toISOString() };
}

export function shapePayout(p: typeof crewPayouts.$inferSelect) {
  return { id: p.id, amount: p.amount, date: p.date, method: p.method, note: p.note, createdAt: p.createdAt.toISOString() };
}
