// backend/src/utils/trustedFileUrl.js
//
// A fleet document's link is opened by Runserv staff from the admin console, so it must be a file Runserv itself stored,
// never an address a fleet user typed (phishing page, tracking link, malware). Our uploads live on Cloudinary under
// <cloud name>/.../runserv/... — anything else is refused.
'use strict';
const { parsePrivateRef, isPrivateMarker } = require('./storageRef');

const isRunservUploadUrl = (raw, env = process.env) => {
  if (typeof raw !== 'string' || raw.length > 2048 || /[\s\u0000-\u001f\\]/.test(raw)) return false;
  const m = /^https:\/\/res\.cloudinary\.com\/([^/?#]+)\/(?:image|raw|video)\/upload\/([^?#]*)$/i.exec(raw);
  if (!m) return false;
  const cloud = env.CLOUDINARY_CLOUD_NAME;
  if (cloud && m[1] !== cloud) return false;               // somebody else's Cloudinary account
  const path = m[2].split('/');
  if (path.includes('..') || path.includes('.')) return false;
  return /(^|\/)runserv\/fleet\//.test(m[2]);              // the folder the fleet upload endpoint writes to
};

/** M13: a fleet document may be a PRIVATE reference under runserv/fleet/ (new) or a legacy public Runserv link. */
const isFleetDocumentRef = (v, env = process.env) => {
  const r = parsePrivateRef(v);
  if (r) return r.publicId.startsWith('runserv/fleet/');
  return isRunservUploadUrl(v, env);
};

/** M13: any driver/partner document value we will accept from a client: a private reference, or a link into OUR Cloudinary account. Never the redaction marker. */
const isStoredDocumentRef = (v, env = process.env) => {
  if (isPrivateMarker(v)) return false;
  if (parsePrivateRef(v)) return true;
  if (typeof v !== 'string' || v.length > 2048 || /[\s\u0000-\u001f\\]/.test(v)) return false;
  const m = /^https:\/\/res\.cloudinary\.com\/([^/?#]+)\/(?:image|raw|video)\/(?:upload|authenticated)\/([^?#]*)$/i.exec(v);
  if (!m || (env.CLOUDINARY_CLOUD_NAME && m[1] !== env.CLOUDINARY_CLOUD_NAME)) return false;
  return /(^|\/)runserv\//.test(m[2]) && !m[2].split('/').includes('..');
};

module.exports = { isRunservUploadUrl, isFleetDocumentRef, isStoredDocumentRef };
