import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { isDateString, isTimeString, parseLimit, parseMoney, validateShootDay } from '../src/utils/validate.js';
import { resolvePlan } from '../src/utils/plan.js';
import { verifyCheckoutSignature, verifyWebhookSignature } from '../src/utils/razorpay.js';
import { serializeUser } from '../src/routes/auth.js';

test('parseMoney accepts whole amounts in range only', () => {
  assert.equal(parseMoney(799), 799);
  assert.equal(parseMoney('1500'), 1500);
  assert.equal(parseMoney(0), 0);
  assert.equal(parseMoney(0, { allowZero: false }), null);
  for (const bad of [1.5, -1, 2_000_000_001, 'abc', '', null, undefined, NaN, Infinity, {}]) {
    assert.equal(parseMoney(bad), null, `should reject ${String(bad)}`);
  }
});

test('date and time formats', () => {
  assert.ok(isDateString('2026-10-13'));
  assert.ok(!isDateString('2026-02-30'));
  assert.ok(!isDateString('13/10/2026'));
  assert.ok(isTimeString('09:30'));
  assert.ok(isTimeString(''));
  assert.ok(!isTimeString('25:00'));
  assert.ok(!isTimeString('9:30am'));
});

test('parseLimit clamps page size', () => {
  assert.equal(parseLimit('100000', 50), 100);
  assert.equal(parseLimit('abc', 50), 50);
  assert.equal(parseLimit('0', 50), 50);
  assert.equal(parseLimit('20', 50), 20);
});

test('validateShootDay derives the maps link and never trusts a client one', () => {
  const ok = validateShootDay({ date: '2026-11-01', time: '07:00', locationJSON: { name: 'Bandra Fort', mapsUrl: 'https://evil.example' } });
  assert.ok(ok.ok);
  if (ok.ok) assert.equal(ok.value.locationJSON.mapsUrl, 'https://maps.google.com/?q=Bandra%20Fort');
  const bad = validateShootDay({ date: 'tomorrow', time: 'noon' }, 'd.');
  assert.ok(!bad.ok);
  if (!bad.ok) assert.deepEqual(Object.keys(bad.fields).sort(), ['d.date', 'd.time']);
});

test('plan resolution: free, early bird, admin, paid, lapsed', () => {
  const now = new Date('2026-10-13T00:00:00Z');
  const base = { isPro: false, proUntil: null, activatedAt: null, paidProUntil: null };
  const d = (s: string) => new Date(s);

  assert.equal(resolvePlan(base, null, now).tier, 'free');

  const early = resolvePlan({ ...base, activatedAt: d('2026-10-01') }, null, now);
  assert.equal(early.source, 'early_access');
  assert.equal(early.proUntil?.toISOString().slice(0, 10), '2027-04-01');

  const ended = resolvePlan({ ...base, activatedAt: d('2026-03-01') }, null, now);
  assert.equal(ended.tier, 'free');
  assert.equal(ended.lapsed?.source, 'early_access');

  const afterClose = resolvePlan({ ...base, activatedAt: d('2027-01-05') }, d('2027-01-01'), d('2027-01-10'));
  assert.equal(afterClose.tier, 'free');

  const longest = resolvePlan({ ...base, activatedAt: d('2026-10-01'), isPro: true, proUntil: d('2027-06-01'), paidProUntil: d('2028-04-01') }, null, now);
  assert.equal(longest.source, 'paid');

  const refunded = resolvePlan({ ...base, paidProUntil: d('2026-10-10') }, null, now);
  assert.equal(refunded.tier, 'free');
  assert.equal(refunded.lapsed?.source, 'paid');
});

test('Razorpay signatures: valid passes, tampered fails', () => {
  const sig = crypto.createHmac('sha256', 'test-key-secret').update('order_1|pay_1').digest('hex');
  assert.ok(verifyCheckoutSignature('order_1', 'pay_1', sig));
  assert.ok(!verifyCheckoutSignature('order_2', 'pay_1', sig));
  assert.ok(!verifyCheckoutSignature('order_1', 'pay_1', 'short'));

  const body = Buffer.from('{"event":"payment.captured"}');
  const wsig = crypto.createHmac('sha256', 'test-webhook-secret').update(body).digest('hex');
  assert.ok(verifyWebhookSignature(body, wsig));
  assert.ok(!verifyWebhookSignature(Buffer.from('{"event":"payment.failed"}'), wsig));
});

test('serializeUser never returns credentials', () => {
  const row = {
    id: 'u1', name: 'A', email: 'a@b.c', passwordHash: 'hash', resetToken: 'live-token',
    resetTokenExpiry: new Date(), firstLogin: 0,
  } as unknown as Parameters<typeof serializeUser>[0];
  const out = serializeUser(row) as Record<string, unknown>;
  assert.ok(!('passwordHash' in out));
  assert.ok(!('resetToken' in out));
  assert.ok(!('resetTokenExpiry' in out));
  assert.equal(out.firstLogin, true);
});
