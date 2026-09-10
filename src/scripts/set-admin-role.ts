/**
 * One-off CLI to grant/revoke the 'admin' role on an existing account.
 * There's no public "become admin" endpoint, so this is the only way to
 * create the first superadmin (or promote/demote later ones).
 *
 * Usage:
 *   npx tsx src/scripts/set-admin-role.ts you@example.com
 *   npx tsx src/scripts/set-admin-role.ts you@example.com --revoke
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  const revoke = process.argv.includes('--revoke');

  if (!email) {
    console.error('Usage: npx tsx src/scripts/set-admin-role.ts <email> [--revoke]');
    process.exit(1);
  }

  const role = revoke ? 'user' : 'admin';

  const [updated] = await db
    .update(users)
    .set({ role, updatedAt: new Date() })
    .where(eq(users.email, email))
    .returning({ id: users.id, email: users.email, role: users.role });

  if (!updated) {
    console.error(`No user found with email: ${email}`);
    process.exit(1);
  }

  console.log(`OK — ${updated.email} (${updated.id}) is now role="${updated.role}"`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Failed to update role:', err);
    process.exit(1);
  });
