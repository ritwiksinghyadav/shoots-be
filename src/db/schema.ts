import { pgTable, uuid, text, smallint, boolean, timestamp, AnyPgColumn, integer, jsonb, unique, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Timestamp column that auto-sets on insert (defaultNow) AND auto-updates on every
 * UPDATE via Drizzle's `$onUpdate` hook. Eliminates the need to manually pass
 * `updatedAt: new Date()` in application code.
 */
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date());

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name'),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash'),
  businessName: text('business_name'),
  /** E.164-style, e.g. "+919876543210". Null until the user sets one. */
  phone: text('phone'),
  /**
   * Free-text profession (UI label: "Profession") — the frontend offers
   * suggestions via a Combobox but doesn't restrict the value to them.
   * Nullable at the DB level so existing rows survive the migration, but
   * treated as mandatory by the application: enforced client-side in
   * onboarding/profile forms and validated server-side in `PUT /auth/me`.
   */
  occupation: text('occupation'),
  preferredCurrency: text('preferred_currency').notNull().default('INR'),
  /** Free text, same convention as `projects.status`/`feedback.type` — 'user' | 'admin' today. */
  role: text('role').notNull().default('user'),
  /** Who first added this person. Cleared, not cascaded, if the inviter's account is deleted. */
  invitedBy: uuid('invited_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  firstLogin: smallint('first_login').default(1).notNull(),
  isVerified: boolean('is_verified').default(false).notNull(),
  /** Membership tier, admin-controlled — no self-serve or payment flow behind this yet. */
  isPro: boolean('is_pro').default(false).notNull(),
  /**
   * End of an admin-granted Pro term (6 months by default, see TERM_MONTHS.admin).
   * Pro is never permanent: once this passes the grant has lapsed even though
   * `isPro` is still true. Null only on grants made before dates existed.
   */
  proUntil: timestamp('pro_until', { withTimezone: true }),
  /**
   * End of the paid Pro term bought through Razorpay. Each payment adds 12
   * months on top of whatever term was running, and a refund takes its months
   * back off. Denormalised from `payments` so plan checks stay a single-row read.
   */
  paidProUntil: timestamp('paid_pro_until', { withTimezone: true }),
  /**
   * When the account first became usable, i.e. a password was first set
   * (direct signup, claiming a crew invite, or an admin setting one). Null for
   * placeholder rows created by a crew invite or an unfinished signup. Early
   * access is judged on this, not `createdAt`: being invited by someone else
   * during early access must not grant Pro to a person who joins later.
   */
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  resetToken: text('reset_token'),
  resetTokenExpiry: timestamp('reset_token_expiry', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: updatedAt(),
});

/**
 * One row per signed-in device/session. The row's `id` is carried in the refresh
 * token's `jti` claim, which is what makes refresh tokens revocable per-device:
 * logging out on a phone revokes only that row, leaving the laptop signed in.
 * Password change/reset revokes every row for the user instead.
 *
 * A row survives token rotation — POST /auth/refresh reissues a new token string
 * carrying the same `jti`, so concurrent refreshes from the same session both stay
 * valid rather than racing each other into a spurious logout.
 */
export const refreshSessions = pgTable('refresh_sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Mirrors the refresh token's own 60-day expiry, so expired rows can be pruned. */
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('refresh_sessions_user_id_idx').on(table.userId),
]);


export const projects = pgTable('projects', {
  id: uuid('id').defaultRandom().primaryKey(),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  client: text('client').notNull(),
  status: text('status').notNull().default('inquiry'),
  /**
   * Budget stored in major currency units (e.g. dollars, euros), not cents.
   */
  budget: integer('budget').notNull().default(0),
  icon: text('icon'),
  notes: text('notes'),
  /**
   * Denormalized "current stage" of production/delivery (e.g. 'booked',
   * 'shooting', 'editing', 'delivered') — free text, same convention as
   * `status`. Kept in sync with the latest row in `shoot_milestones` so list
   * views can show a badge without joining/aggregating per project. This is
   * deliberately a separate concept from `status`: `status` is the
   * inquiry/booked/paid business pipeline, this is what's actually happening
   * with the shoot day-to-day — the two can and will diverge (a shoot can be
   * `booked` and simultaneously "in editing").
   */
  productionStage: text('production_stage').notNull().default('booked'),
  /**
   * Random opaque token for the read-only public share page
   * (`/s/:shareToken`). Null until the owner enables sharing for the first
   * time; kept (not cleared) when sharing is disabled via `shareEnabled` so
   * re-enabling doesn't mint a new link. Unique so it can double as the
   * lookup key for the public route.
   */
  shareToken: text('share_token').unique(),
  shareEnabled: boolean('share_enabled').notNull().default(false),
  /**
   * Sum of `client_payments.amount` for this project, in major units. Kept in
   * step by the same statement that adds or removes a payment
   * (utils/money.ts), so lists can show "received / due" without a join.
   */
  amountReceived: integer('amount_received').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: updatedAt(),
}, (table) => [
  index('projects_title_trgm_idx').using('gin', sql`lower(${table.title}) gin_trgm_ops`),
  index('projects_client_trgm_idx').using('gin', sql`lower(${table.client}) gin_trgm_ops`),
]);

export const shootMilestones = pgTable('shoot_milestones', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  /** Free text, same convention as `projects.status`/`productionStage` — a fixed set is offered in the UI but not enforced here. */
  stage: text('stage').notNull(),
  note: text('note'),
  /** Optional YYYY-MM-DD the milestone happened/is expected — distinct from `createdAt`, which is when the log entry was made. */
  date: text('date'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('shoot_milestones_project_idx').on(table.projectId),
]);

export const shootDays = pgTable('shoot_days', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  date: text('date').notNull(),
  time: text('time').notNull(),
  locationJSON: jsonb('location_json').notNull(),
  shootOrder: integer('shoot_order').notNull().default(1),
  eventTitle: text('event_title'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: updatedAt(),
}, (table) => [
  index('shoot_days_location_name_trgm_idx').using('gin', sql`lower(${table.locationJSON}->>'name') gin_trgm_ops`),
]);

export const shootMembers = pgTable('shoot_members', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  /**
   * 'unpaid' | 'partial' | 'paid', derived from `amountPaid` against `payment`
   * whenever either changes (utils/money.ts). The one exception is a ₹0 fee,
   * where 'paid'/'unpaid' is set by hand because there's nothing to pay out.
   */
  paymentStatus: text('payment_status').notNull().default('unpaid'),
  /**
   * The agreed fee, in major currency units (e.g. dollars, euros), not cents.
   */
  payment: integer('payment').notNull().default(0),
  /** Sum of this member's `crew_payouts.amount`. Never more than `payment`. */
  amountPaid: integer('amount_paid').notNull().default(0),
  invited: boolean('invited').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: updatedAt(),
});

export const expenses = pgTable('expenses', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  /**
   * Amount stored in major currency units (e.g. dollars, euros), not cents.
   */
  amount: integer('amount').notNull().default(0),
  category: text('category').default('misc').notNull(),
  date: text('date'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: updatedAt(),
});

export const feedback = pgTable('feedback', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** 'feedback' | 'bug' — kept as free text rather than a pg enum so new types don't need a migration. */
  type: text('type').notNull().default('feedback'),
  message: text('message').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('feedback_user_created_idx').on(table.userId, table.createdAt),
]);

export const teamMembers = pgTable('team_members', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  memberId: uuid('member_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: updatedAt(),
}, (t) => [
  unique().on(t.userId, t.memberId)
]);

/**
 * Admin-editable app settings, one row per key. Values are text so a new
 * setting never needs a migration; each reader parses and validates its own.
 */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value'),
  updatedAt: updatedAt(),
});

/**
 * One row per Razorpay order: the full history of every payment attempt, and
 * what a refund needs. Amounts are in paise (smallest unit), unlike the
 * project money columns, because that's what Razorpay sends and refunds take.
 *
 * Status moves created → paid → refunded (or partially_refunded); a failed
 * attempt marks it `failed`, and a later successful attempt on the same order
 * can still move it to `paid`. Every transition is a conditional UPDATE, so the
 * checkout callback and the webhook can both arrive and only one applies.
 */
export const payments = pgTable('payments', {
  id: uuid('id').defaultRandom().primaryKey(),
  /** Kept as null if the account is deleted, so the money trail survives. */
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  /** Snapshot at order time, for the same reason. */
  email: text('email').notNull(),
  provider: text('provider').notNull().default('razorpay'),
  /** Razorpay order id (order_XXX). */
  orderId: text('order_id').notNull().unique(),
  /** Razorpay payment id (pay_XXX) of the attempt that succeeded, or the last one that failed. */
  paymentId: text('payment_id').unique(),
  amount: integer('amount').notNull(),
  currency: text('currency').notNull().default('INR'),
  /** 'created' | 'paid' | 'failed' | 'refunded' | 'partially_refunded' */
  status: text('status').notNull().default('created'),
  /** upi | card | netbanking | wallet | … as Razorpay reports it. */
  method: text('method'),
  /** The Pro term this payment bought. Set when it's marked paid. */
  periodStart: timestamp('period_start', { withTimezone: true }),
  periodEnd: timestamp('period_end', { withTimezone: true }),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  failureReason: text('failure_reason'),
  refundId: text('refund_id'),
  /** Total refunded so far, in paise. */
  amountRefunded: integer('amount_refunded').notNull().default(0),
  refundedAt: timestamp('refunded_at', { withTimezone: true }),
  /** Who issued the refund: an admin's user id, or null when it came from the Razorpay dashboard. */
  refundedBy: uuid('refunded_by').references(() => users.id, { onDelete: 'set null' }),
  /** The latest payment entity from Razorpay, verbatim, for support and audits. */
  raw: jsonb('raw'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: updatedAt(),
}, (table) => [
  index('payments_user_created_idx').on(table.userId, table.createdAt),
  index('payments_status_idx').on(table.status),
]);

/**
 * Money received from the client for a project: advances, part payments and
 * the final settlement, one row each. `projects.amountReceived` is their sum.
 * Amounts are whole major units, like every other project money column.
 */
export const clientPayments = pgTable('client_payments', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  amount: integer('amount').notNull(),
  /** YYYY-MM-DD the money came in. */
  date: text('date').notNull(),
  /** 'upi' | 'cash' | 'bank' | 'card' | 'cheque' | 'other', or null if not recorded. */
  method: text('method'),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('client_payments_project_idx').on(table.projectId),
]);

/**
 * Money paid to a crew member for one project, in instalments.
 * `shoot_members.amountPaid` is their sum.
 */
export const crewPayouts = pgTable('crew_payouts', {
  id: uuid('id').defaultRandom().primaryKey(),
  shootMemberId: uuid('shoot_member_id').notNull().references(() => shootMembers.id, { onDelete: 'cascade' }),
  amount: integer('amount').notNull(),
  /** YYYY-MM-DD the money was paid. */
  date: text('date').notNull(),
  /** Same values as client_payments.method. */
  method: text('method'),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('crew_payouts_member_idx').on(table.shootMemberId),
]);
