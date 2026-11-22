'use strict';
// Shared fixtures for the M16.1 email tests: a fully configured two-provider environment and a recording fake HTTP client.
const env = {
  NODE_ENV: 'test', JWT_SECRET: 'test-secret',
  GUEST_EMAIL_OTP_ENABLED: 'true', GUEST_OTP_CHANNEL: 'email', GUEST_OTP_HASH_SECRET: 'otp-secret-for-tests-0123456789abcdef',
  BREVO_ENABLED: 'true', BREVO_API_KEY: 'brevo-key', BREVO_SENDER_EMAIL: 'no-reply@example.com', BREVO_SENDER_NAME: 'Runserv',
  RESEND_ENABLED: 'true', RESEND_API_KEY: 'resend-key', RESEND_SENDER_EMAIL: 'no-reply@example.com',
  EMAIL_QUOTA_WINDOW_TIMEZONE: 'UTC', EMAIL_QUOTA_RESET_OFFSET_MINUTES: '0',
};

/** http.post resolves by provider host. `plan(provider, n, body)` may return { status, data } or throw {code}. Default: accept. */
const makeHttp = (plan = () => null) => {
  const calls = [];
  const post = jest.fn(async (url, body, cfg) => {
    const provider = url.includes('brevo') ? 'brevo' : 'resend';
    const n = calls.filter((c) => c.provider === provider).length + 1;
    calls.push({ provider, url, body, headers: cfg.headers });
    const r = plan(provider, n, body);
    if (r && r.throw) throw Object.assign(new Error(r.throw), { code: r.throw });
    if (r) return r;
    return { status: provider === 'brevo' ? 201 : 200, data: provider === 'brevo' ? { messageId: `<brevo-${calls.length}@x>` } : { id: `resend-${calls.length}` } };
  });
  return { post, calls };
};
/** The 6-digit code out of what a provider was handed. */
const codeIn = (call) => /(\d{6})/.exec(call.body.textContent || call.body.text)[1];

module.exports = { env, makeHttp, codeIn };
