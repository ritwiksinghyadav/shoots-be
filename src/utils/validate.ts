/**
 * Shared input checks for the project routes. Money columns are Postgres
 * `integer` (major currency units), so anything that isn't a whole number in
 * range must be rejected here as a 400, not left to fail as a 500 in the DB.
 */

/** Upper bound for any single money value; well inside int4 (2,147,483,647). */
export const MAX_MONEY = 2_000_000_000;

// 'partial' is accepted as input meaning "leave the payouts as they are"; it's
// derived from payouts, so sending it never changes anything on its own.
export const PAYMENT_STATUSES = ['paid', 'partial', 'unpaid'] as const;
export type PaymentStatusValue = (typeof PAYMENT_STATUSES)[number];

/** Whole number from 0 to MAX_MONEY, given as a number or numeric string. */
export function parseMoney(value: unknown, { allowZero = true } = {}): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  if (!Number.isInteger(n) || n > MAX_MONEY || n < (allowZero ? 0 : 1)) return null;
  return n;
}

export const MONEY_MESSAGE = `Enter a whole number between 0 and ${MAX_MONEY.toLocaleString('en-IN')}`;

/** YYYY-MM-DD that is a real calendar date. */
export function isDateString(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** HH:MM (24h) or empty, the two shapes the app's TimePicker produces. */
export function isTimeString(value: unknown): value is string {
  return typeof value === 'string' && (value === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(value));
}

/** Optional free text: undefined (not sent), null or a string up to `max` characters. */
export function isOptionalText(value: unknown, max = 5000): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.length <= max);
}

export function isPaymentStatus(value: unknown): value is PaymentStatusValue {
  return typeof value === 'string' && (PAYMENT_STATUSES as readonly string[]).includes(value);
}

/** Positive integer page size, clamped to `max`. */
export function parseLimit(value: unknown, fallback: number, max = 100): number {
  const n = parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

export function parsePage(value: unknown): number {
  const n = parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

export interface ShootDayValue {
  date: string;
  time: string;
  locationJSON: { name: string; mapsUrl?: string };
  eventTitle: string | null;
}

/**
 * A shoot day as the app sends it. Returns field errors keyed under `prefix`,
 * or the cleaned values ready to insert.
 */
export function validateShootDay(
  body: Record<string, unknown>,
  prefix = '',
): { ok: true; value: ShootDayValue } | { ok: false; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  const loc = body.locationJSON as { name?: unknown } | undefined;
  const name = loc && typeof loc === 'object' && typeof loc.name === 'string' ? loc.name.trim() : '';

  if (!isDateString(body.date)) fields[`${prefix}date`] = 'Date must be YYYY-MM-DD';
  if (body.time !== undefined && !isTimeString(body.time)) fields[`${prefix}time`] = 'Time must be HH:MM';
  if (loc !== undefined && (typeof loc !== 'object' || loc === null)) fields[`${prefix}locationJSON`] = 'Location is invalid';
  if (name.length > 300) fields[`${prefix}locationJSON`] = 'Location is too long';
  if (!isOptionalText(body.eventTitle, 1000)) fields[`${prefix}eventTitle`] = 'Notes are too long';
  if (Object.keys(fields).length > 0) return { ok: false, fields };

  return {
    ok: true,
    value: {
      date: body.date as string,
      time: (body.time as string | undefined) ?? '',
      // The maps link is always derived here, never taken from the client.
      locationJSON: name ? { name, mapsUrl: `https://maps.google.com/?q=${encodeURIComponent(name)}` } : { name: '' },
      eventTitle: typeof body.eventTitle === 'string' && body.eventTitle.trim() ? body.eventTitle.trim() : null,
    },
  };
}
