// backend/src/routes/brand.routes.js — public, mounted at /api/public
// The web portal calls this BEFORE login to paint the organisation's logo, colours and name
// (white label) and to serve a per-organisation installable-app manifest.
'use strict';
const express = require('express');
const { findCompanyByHost } = require('../utils/brandHosts');

const router = express.Router();
const RUNSERV = { name: 'Runserv', logoUrl: null, color: '#1D4ED8', accent: '#0EA5E9', tagline: 'Business rides & deliveries', supportEmail: null, slug: null, whiteLabel: false };

const brandFor = async (host) => {
  const c = await findCompanyByHost(host);
  if (!c) return RUNSERV;
  return { name: c.brandName || c.name, logoUrl: c.logoUrl, color: c.brandColor || RUNSERV.color, accent: c.brandAccent || RUNSERV.accent, tagline: c.tagline, supportEmail: c.supportEmail, slug: c.slug, whiteLabel: true };
};

router.get('/brand', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ success: true, data: { brand: await brandFor(req.query.host || req.hostname) } });
});

router.get('/manifest.webmanifest', async (req, res) => {
  const b = await brandFor(req.query.host || req.hostname);
  const icons = b.logoUrl
    ? [{ src: b.logoUrl, sizes: '512x512', type: /\.svg(\?|$)/i.test(b.logoUrl) ? 'image/svg+xml' : /\.jpe?g(\?|$)/i.test(b.logoUrl) ? 'image/jpeg' : 'image/png', purpose: 'any' }]
    : [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }, { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }];
  res.set('Content-Type', 'application/manifest+json').set('Cache-Control', 'public, max-age=300').send(JSON.stringify({
    name: `${b.name} — Business`, short_name: b.name.slice(0, 12), description: `${b.name} ride & delivery dashboard`, start_url: '/?source=pwa', scope: '/',
    display: 'standalone', background_color: '#0f1623', theme_color: b.color, icons,
  }));
});

/** M13: which vehicle categories are in service, so the apps hide the rest. */
router.get('/vehicle-categories', (req, res) => res.json({ success: true, data: { enabled: require('../utils/vehicleCategories').enabledCategories() } }));

/** M14: which map technology the app should use (set in the admin console; contains no keys). */
router.get('/map-config', require('../controllers/maps.controller').publicConfig);

module.exports = router;
