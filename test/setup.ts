// Loaded before every test file (see the `test` script). Sets every secret to a
// throwaway value *before* anything imports dotenv, which never overrides an
// existing variable, so the suite can't reach the live database or Razorpay.
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
process.env.RAZORPAY_KEY_SECRET = 'test-key-secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.FRONTEND_URL = '';
