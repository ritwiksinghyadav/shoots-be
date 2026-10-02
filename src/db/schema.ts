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
  invitedBy: uuid('invited_by').references((): AnyPgColumn => users.id),
  firstLogin: smallint('first_login').default(1).notNull(),
  isVerified: boolean('is_verified').default(false).notNull(),
  /** Membership tier, admin-controlled — no self-serve or payment flow behind this yet. */
  isPro: boolean('is_pro').default(false).notNull(),
  /**
   * End of an admin-granted Pro term (12 months by default, see PRO_TERM_MONTHS).
   * Pro is never permanent: once this passes the grant has lapsed even though
   * `isPro` is still true. Null only on grants made before dates existed.
   */
  proUntil: timestamp('pro_until', { withTimezone: true }),
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
  paymentStatus: text('payment_status').notNull().default('unpaid'),
  /**
   * Payment stored in major currency units (e.g. dollars, euros), not cents.
   */
  payment: integer('payment').notNull().default(0),
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
