// backend/src/controllers/maps.controller.js — M14
'use strict';
const { AppError } = require('../middleware/errorHandler');
const routing = require('../services/maps/routing.service');
const mapConfig = require('../services/maps/mapConfig.service');

const pt = (p) => ({ latitude: Number(p?.latitude), longitude: Number(p?.longitude) });

/** POST /api/maps/route { from:{latitude,longitude}, to:{...} } -> { coords, distanceM, durationS, provider } | { route:null } */
exports.route = async (req, res) => {
  const from = pt(req.body.from); const to = pt(req.body.to);
  if (!routing.valid(from) || !routing.valid(to)) throw new AppError('from and to must be valid coordinates.', 400);
  const r = await routing.routeBetween(from, to);
  res.set('Cache-Control', 'private, max-age=60').json({ success: true, data: r ?? { route: null } });
};

/** GET /api/public/map-config — what the APP needs (no keys). */
exports.publicConfig = async (req, res) => {
  res.set('Cache-Control', 'public, max-age=60').json({ success: true, data: await mapConfig.publicConfig() });
};

/** GET /api/admin/maps/config — current setting + what this server can serve. */
exports.adminGet = async (req, res) => {
  const config = await mapConfig.getConfig();
  res.json({ success: true, data: { config, warnings: mapConfig.warningsFor(config), availability: mapConfig.availability(), options: { renderer: mapConfig.RENDERERS, routing: mapConfig.ROUTING, places: mapConfig.PLACES } } });
};

/** PUT /api/admin/maps/config — SUPER_ADMIN. Validates that the chosen provider is actually usable. */
exports.adminSet = async (req, res) => {
  const config = await mapConfig.setConfig(req.body, req.user, req);
  routing.clearCache();
  res.json({ success: true, message: 'Map settings saved. Apps pick this up within a minute.', data: { config, warnings: mapConfig.warningsFor(config) } });
};

/** POST /api/admin/maps/test-route — try the SELECTED provider on a sample trip so you can verify before relying on it. */
exports.adminTest = async (req, res) => {
  const cfg = await mapConfig.getConfig();
  const from = pt(req.body.from); const to = pt(req.body.to);
  if (!routing.valid(from) || !routing.valid(to)) throw new AppError('Provide from and to coordinates.', 400);
  const started = Date.now();
  let r = null;
  try { r = await routing.adapters[cfg.routing](from, to); } catch (e) { return res.json({ success: true, data: { ok: false, provider: cfg.routing, error: String(e.message).slice(0, 200), ms: Date.now() - started } }); }
  res.json({ success: true, data: { ok: true, provider: cfg.routing, distanceM: r.distanceM, durationS: r.durationS, points: r.coords.length, ms: Date.now() - started } });
};
