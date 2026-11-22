'use strict';
process.env.JWT_SECRET = 'test-secret';
jest.mock('../src/lib/prisma', () => ({}));
const express = require('express');
const http = require('http');
const router = require('../src/routes/guestTrackPage.routes');

const get = (app, path) => new Promise((resolve, reject) => {
  const srv = app.listen(0, () => {
    http.get({ port: srv.address().port, path }, (res) => { let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => { srv.close(); resolve({ status: res.statusCode, headers: res.headers, body }); }); }).on('error', reject);
  });
});
const mkApp = () => { const a = express(); a.use((req, res, next) => { res.locals.cspNonce = 'NONCE123'; next(); }); a.use('/t', router); return a; };
const TOKEN = `gt_${'A'.repeat(43)}`;

describe('guest tracking page (/t/:token)', () => {
  test('a well-formed token gets the shell page with the CSP nonce, no-store, noindex and no referrer', async () => {
    const r = await get(mkApp(), `/t/${TOKEN}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/html/);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-robots-tag']).toMatch(/noindex/);
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.body).toContain('<script nonce="NONCE123">');
    expect(r.body).toContain('/api/guest/track/');
  });
  test('the token is never embedded in the HTML (the page reads it from the URL in the browser)', async () => {
    expect((await get(mkApp(), `/t/${TOKEN}`)).body).not.toContain(TOKEN);
  });
  test('user-supplied text is only ever written with textContent (no innerHTML / document.write / eval)', async () => {
    const { body } = await get(mkApp(), `/t/${TOKEN}`);
    expect(body).not.toMatch(/innerHTML|document\.write|eval\(|outerHTML/);
  });
  test('malformed tokens get a 404 page with no polling script', async () => {
    for (const p of ['/t/abc', `/t/${TOKEN}x`, '/t/%3Cscript%3E']) {
      const r = await get(mkApp(), p);
      expect(r.status).toBe(404);
      expect(r.body).not.toContain('<script');
    }
  });
});
