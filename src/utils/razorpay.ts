import crypto from 'node:crypto';

/**
 * Thin Razorpay REST client: just the calls billing needs, over fetch with
 * basic auth. No SDK, so nothing extra to keep patched. Keys come from env
 * only (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET);
 * use test-mode keys until launch. Amounts are always in paise.
 */

// Overridable only so tests can point it at a local mock; never set in production.
const API = process.env.RAZORPAY_API_BASE || 'https://api.razorpay.com/v1';

export function razorpayConfigured(): boolean {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

export function razorpayKeyId(): string {
  return process.env.RAZORPAY_KEY_ID ?? '';
}

/** Thrown for any non-2xx answer, carrying Razorpay's own error text. */
export class RazorpayError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } = process.env;
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    throw new RazorpayError(503, 'Razorpay keys are not configured');
  }
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { code?: string; description?: string } };
  if (!res.ok) {
    throw new RazorpayError(res.status, json.error?.description ?? `Razorpay ${method} ${path} failed`, json.error?.code);
  }
  return json as T;
}

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  status: 'created' | 'attempted' | 'paid';
  receipt: string | null;
}

export interface RazorpayPayment {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  /** 'created' | 'authorized' | 'captured' | 'refunded' | 'failed' */
  status: string;
  method: string | null;
  amount_refunded: number;
  refund_status: 'null' | 'partial' | 'full' | null;
  error_description?: string | null;
  email?: string;
  contact?: string;
  created_at: number;
  [key: string]: unknown;
}

export interface RazorpayRefund {
  id: string;
  payment_id: string;
  amount: number;
  status: 'pending' | 'processed' | 'failed';
  [key: string]: unknown;
}

export function createOrder(input: { amount: number; currency: string; receipt: string; notes: Record<string, string> }) {
  return call<RazorpayOrder>('POST', '/orders', input);
}

export function fetchPayment(paymentId: string) {
  return call<RazorpayPayment>('GET', `/payments/${encodeURIComponent(paymentId)}`);
}

/** Only needed if the account isn't set to auto-capture; harmless otherwise. */
export function capturePayment(paymentId: string, amount: number, currency: string) {
  return call<RazorpayPayment>('POST', `/payments/${encodeURIComponent(paymentId)}/capture`, { amount, currency });
}

/** Full refund when `amount` is omitted. `speed: 'normal'` is free; 'optimum' costs extra. */
export function refundPayment(paymentId: string, notes: Record<string, string>, amount?: number) {
  return call<RazorpayRefund>('POST', `/payments/${encodeURIComponent(paymentId)}/refund`, {
    ...(amount !== undefined ? { amount } : {}),
    speed: 'normal',
    notes,
  });
}

function safeEqualHex(expected: string, received: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Checkout success handler: HMAC-SHA256(order_id|payment_id, key_secret). */
export function verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
  return safeEqualHex(expected, signature);
}

/** Webhooks: HMAC-SHA256 of the raw request body with the webhook secret. */
export function verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqualHex(expected, signature);
}
