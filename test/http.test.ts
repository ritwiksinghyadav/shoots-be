// Real HTTP requests against the Express app on a random port. Every case
// here is decided before the database is touched (routing, CORS, auth,
// validation, rate limits), so no database is needed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { generateAccessToken } from '../src/utils/auth.js';
import app from '../src/app.js';

let server: Server;
let base = '';
const token = generateAccessToken({ userId: '00000000-0000-4000-8000-000000000001', email: 'owner@example.com' });
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

before(async () => {
  server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

test('unknown routes are 404, not 401', async () => {
  const res = await fetch(`${base}/api/v1/does-not-exist`);
  assert.equal(res.status, 404);
});

test('signed-in routes still require a token', async () => {
  for (const path of ['/api/v1/projects', '/api/v1/team-members', '/api/v1/feedback/status', '/api/v1/admin/users']) {
    assert.equal((await fetch(`${base}${path}`)).status, 401, path);
  }
});

test('POST /auth/register no longer exists', async () => {
  const res = await fetch(`${base}/api/v1/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x', email: 'x@y.z' }),
  });
  assert.equal(res.status, 404);
});

test('unknown origins get 403 with no stack trace', async () => {
  const res = await fetch(`${base}/api/v1/auth/signup-request`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error.code, 'CORS_FORBIDDEN');
  assert.ok(!('stack' in body.error));
});

test('the app domain passes CORS', async () => {
  const res = await fetch(`${base}/api/v1/auth/signup-request`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://shoots.bnwapphub.com', 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://shoots.bnwapphub.com');
});

test('webhook rejects a bad signature', async () => {
  const res = await fetch(`${base}/api/v1/billing/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': 'bad' }, body: '{}',
  });
  assert.equal(res.status, 400);
});

test('malformed ids are 404', async () => {
  const res = await fetch(`${base}/api/v1/projects/not-a-uuid`, { headers: auth });
  assert.equal(res.status, 404);
});

test('creating a shoot validates money, dates and times', async () => {
  const res = await fetch(`${base}/api/v1/projects`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      title: 'Test', client: 'Client', budget: 1.5, status: 'whatever',
      shootDays: [{ date: '31-12-2026', time: '7am', locationName: 'X' }],
    }),
  });
  assert.equal(res.status, 400);
  const { error } = await res.json();
  assert.ok(error.fields.budget);
  assert.ok(error.fields.status);
  assert.ok(error.fields['shootDays[0].date']);
  assert.ok(error.fields['shootDays[0].time']);
});

test('crew invites are capped per request', async () => {
  const emails = Array.from({ length: 21 }, (_, i) => `crew${i}@example.com`);
  const res = await fetch(`${base}/api/v1/projects/00000000-0000-4000-8000-0000000000aa/members`, {
    method: 'POST', headers: auth, body: JSON.stringify({ emails }),
  });
  assert.equal(res.status, 400);
});

test('login is rate limited per account', async () => {
  // No password, so each attempt fails validation before any database work,
  // but it still counts toward the limit.
  let last = 0;
  for (let i = 0; i < 11; i++) {
    const res = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'victim@example.com' }),
    });
    last = res.status;
    if (i < 10) assert.equal(res.status, 400, `attempt ${i + 1}`);
  }
  assert.equal(last, 429);
});

test('refresh cookie is always Secure and SameSite=None (no NODE_ENV involved)', async () => {
  // Logout with no token touches no database but still clears the cookie,
  // using the same options the login sets it with.
  const res = await fetch(`${base}/api/v1/auth/logout`, { method: 'POST' });
  const cookie = res.headers.get('set-cookie') ?? '';
  assert.equal(res.status, 200);
  assert.match(cookie, /refreshToken=/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=None/);
  assert.match(cookie, /HttpOnly/);
});
