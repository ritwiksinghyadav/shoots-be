/**
 * One-off backfill for the plan dates, run once after `npm run db:push` adds
 * `users.activated_at` and `users.pro_until`. Safe to re-run.
 *
 *  - activated_at: activation wasn't tracked before. Every account that
 *    already has a password counts as activated at the rollout (the moment
 *    this runs), so everyone on SHOOTS today gets a full free early-bird term
 *    from launch and nobody drops to Free on the day it ships. Rows an
 *    earlier version of this script dated to their created_at are moved to
 *    the rollout too (they're recognisable: real activations are stamped at a
 *    different moment from row creation, so they never equal it exactly).
 *    Placeholder rows (crew invites, unfinished signups) stay null and are
 *    judged when they actually activate.
 *  - pro_until: admin Pro grants had no end date. Each gets TERM_MONTHS.admin
 *    from the rollout, since Pro is never permanent.
 *
 * Usage:
 *   npx tsx src/scripts/backfill-plan-dates.ts            # dry run, counts only
 *   npx tsx src/scripts/backfill-plan-dates.ts --apply
 */
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { TERM_MONTHS, addMonths } from '../utils/plan.js';

async function main() {
  const apply = process.argv.includes('--apply');
  const rollout = new Date();
  const rolloutIso = rollout.toISOString();
  const grantEnd = addMonths(rollout, TERM_MONTHS.admin).toISOString();

  // Accounts with a password that have no activation yet, or still carry the
  // created_at date from the earlier backfill. Only accounts that existed
  // before the rollout; nothing created from now on is touched.
  const needsActivation = sql`password_hash IS NOT NULL
    AND created_at < ${rolloutIso}::timestamptz
    AND (activated_at IS NULL OR activated_at = created_at)`;
  const undatedGrant = sql`is_pro = true AND pro_until IS NULL`;

  const counts = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE ${needsActivation})::int AS activations,
      count(*) FILTER (WHERE ${undatedGrant})::int AS grants,
      count(*) FILTER (WHERE password_hash IS NULL)::int AS placeholders
    FROM ${users}
  `);
  const { activations, grants, placeholders } = counts.rows[0] as Record<string, number>;

  console.log(`Rollout: ${rolloutIso}`);
  console.log(`Existing accounts to activate at the rollout: ${activations} (free Pro until ${addMonths(rollout, TERM_MONTHS.early_access).toISOString()})`);
  console.log(`Admin Pro grants without an end date: ${grants} (set to ${grantEnd}, ${TERM_MONTHS.admin} months from now)`);
  console.log(`Placeholder accounts left as not activated: ${placeholders}`);

  if (!apply) {
    console.log('Dry run. Re-run with --apply to write.');
    return;
  }

  // Raw updates so updated_at isn't bumped on every account for a data fix.
  const activated = await db.execute(
    sql`UPDATE ${users} SET activated_at = ${rolloutIso}::timestamptz WHERE ${needsActivation}`
  );
  const dated = await db.execute(
    sql`UPDATE ${users} SET pro_until = ${grantEnd}::timestamptz WHERE ${undatedGrant}`
  );

  console.log(`OK — activated_at set on ${activated.rowCount ?? '?'} account(s), pro_until set on ${dated.rowCount ?? '?'} grant(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
