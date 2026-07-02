import { pgTable, uuid, text, smallint, boolean, timestamp, AnyPgColumn } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash'),
  businessName: text('business_name'),
  invitedBy: uuid('invited_by').references((): AnyPgColumn => users.id),
  firstLogin: smallint('first_login').default(1).notNull(),
  isVerified: boolean('is_verified').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
