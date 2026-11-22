'use strict';
// M16.1: provider adapters: error mapping, base-URL safety, nothing secret leaks.
const p = require('../src/services/emailProviders.service');
const { env, makeHttp } = require('./helpers/emailEnv');

describe('classify', () => {
  const c = (provider, status, body, code) => p.classify(provider, { status, body, code });
  test('maps provider answers to categories', () => {
    expect(c('brevo', 400, { code: 'invalid_parameter', message: 'Invalid email address in to' }).category).toBe('INVALID_ADDRESS');
    expect(c('brevo', 400, { code: 'invalid_parameter', message: 'sender is invalid' }).category).toBe('CONFIG');
    expect(c('brevo', 401, { message: 'Key not found' }).category).toBe('AUTH');
    expect(c('brevo', 402, {}).category).toBe('QUOTA');
    expect(c('brevo', 429, { message: 'Daily sending limit reached' }).category).toBe('QUOTA');
    expect(c('brevo', 429, { message: 'Too many requests' }).category).toBe('TRANSIENT');
    expect(c('resend', 429, { name: 'daily_quota_exceeded', message: 'You have reached your daily email sending quota' }).category).toBe('QUOTA');
    expect(c('resend', 429, { name: 'rate_limit_exceeded', message: 'Too many requests' }).category).toBe('TRANSIENT');
    expect(c('resend', 422, { name: 'validation_error', message: 'Invalid `to` field' }).category).toBe('INVALID_ADDRESS');
    expect(c('resend', 403, { name: 'validation_error', message: 'The domain is not verified' }).category).toBe('AUTH');
    expect(c('brevo', 503, {}).category).toBe('TRANSIENT'); expect(c('brevo', 500, {}).category).toBe('TRANSIENT');
  });
  test('timeouts are AMBIGUOUS; a refused connection is certainly not sent', () => {
    expect(c('brevo', undefined, null, 'ETIMEDOUT')).toMatchObject({ category: 'TIMEOUT', ambiguous: true });
    expect(c('brevo', undefined, null, 'ECONNRESET')).toMatchObject({ category: 'TIMEOUT', ambiguous: true });
    expect(c('brevo', undefined, null, 'ECONNREFUSED')).toMatchObject({ category: 'TRANSIENT', ambiguous: false });
  });
});

describe('send', () => {
  test('a network timeout from the HTTP client becomes an ambiguous TIMEOUT', async () => {
    const http = { post: jest.fn(async () => { throw Object.assign(new Error('timeout of 8000ms exceeded'), { code: 'ECONNABORTED' }); }) };
    await expect(p.sendTransactionalEmail('brevo', { to: 'a@b.co', subject: 's', text: 't', html: 'h' }, { env, http })).rejects.toMatchObject({ category: 'TIMEOUT', ambiguous: true });
  });
  test('accepted without a message id is not trusted', async () => {
    const http = { post: async () => ({ status: 201, data: {} }) };
    await expect(p.sendTransactionalEmail('brevo', { to: 'a@b.co', subject: 's', text: 't', html: 'h' }, { env, http })).rejects.toMatchObject({ category: 'TIMEOUT' });
  });
  test('missing key or sender is a CONFIG error and the key is never in an error message', async () => {
    const e = await p.sendTransactionalEmail('brevo', { to: 'a@b.co' }, { env: { ...env, BREVO_API_KEY: '' }, http: makeHttp() }).catch((x) => x);
    expect(e).toMatchObject({ category: 'CONFIG' }); expect(e.message).not.toContain('brevo-key');
    const http = makeHttp(() => ({ status: 401, data: { message: 'bad' } }));
    const e2 = await p.sendTransactionalEmail('brevo', { to: 'a@b.co', subject: 's', text: 't', html: 'h' }, { env, http }).catch((x) => x);
    expect(JSON.stringify(e2.message)).not.toContain('brevo-key');
  });
  test('the base URL is configuration, https and the provider\'s own host only', () => {
    expect(p.baseUrl('brevo', env)).toBe('https://api.brevo.com/v3');
    expect(p.baseUrl('brevo', { BREVO_API_BASE_URL: 'https://api.brevo.com/v3/' })).toBe('https://api.brevo.com/v3');
    for (const bad of ['http://api.brevo.com/v3', 'https://evil.example.com/v3', 'https://api.brevo.com.evil.com/v3', 'nonsense']) expect(() => p.baseUrl('brevo', { BREVO_API_BASE_URL: bad })).toThrow(/base URL/);
  });
  test('a provider needs the enable flag, a key AND a sender', () => {
    expect(p.isEnabled('brevo', env) && p.isConfigured('brevo', env)).toBe(true);
    expect(p.isConfigured('brevo', { ...env, BREVO_SENDER_EMAIL: '' })).toBe(false);
    expect(p.isEnabled('resend', { ...env, RESEND_ENABLED: 'false' })).toBe(false);
  });
});
