// backend/src/middleware/scrubDocumentUrls.js
//
// M13: NO API response carries a raw document link. Every value of a DOC_URL_FIELDS key is replaced with PRIVATE_MARKER
// (truthy, so "uploaded" badges keep working, but not fetchable). Links come only from POST /api/documents/access.
// Inbound: a client that echoes the marker back can never overwrite a real stored reference.
'use strict';
const { DOC_URL_FIELDS, PRIVATE_MARKER } = require('../utils/storageRef');

const FIELDS = new Set(DOC_URL_FIELDS);
const isPlain = (v) => v !== null && typeof v === 'object' && (Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype);

const scrub = (v) => {
  if (Array.isArray(v)) return v.map(scrub);
  if (!isPlain(v)) return v;
  const out = {};
  for (const [k, val] of Object.entries(v)) out[k] = FIELDS.has(k) && typeof val === 'string' && val ? PRIVATE_MARKER : scrub(val);
  return out;
};

const stripMarkerFromBody = (body) => {
  if (!isPlain(body) || Array.isArray(body)) return;
  for (const k of Object.keys(body)) { if (body[k] === PRIVATE_MARKER) delete body[k]; }
};

const scrubDocumentUrls = (req, res, next) => {
  stripMarkerFromBody(req.body);
  const json = res.json.bind(res);
  res.json = (payload) => json(scrub(payload));
  next();
};

module.exports = { scrubDocumentUrls, scrub, stripMarkerFromBody };
