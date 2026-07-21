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
  preferredCurrency: text('preferred_currency').notNull().default('USD'),
  invitedBy: uuid('invited_by').references((): AnyPgColumn => users.id),
  firstLogin: smallint('first_login').default(1).notNull(),
  isVerified: boolean('is_verified').default(false).notNull(),
  resetToken: text('reset_token'),
  resetTokenExpiry: timestamp('reset_token_expiry', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: updatedAt(),
});


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
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: updatedAt(),
}, (table) => [
  index('projects_title_trgm_idx').using('gin', sql`lower(${table.title}) gin_trgm_ops`),
  index('projects_client_trgm_idx').using('gin', sql`lower(${table.client}) gin_trgm_ops`),
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

export const teamMembers = pgTable('team_members', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  memberId: uuid('member_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: updatedAt(),
}, (t) => [
  unique().on(t.userId, t.memberId)
]);
