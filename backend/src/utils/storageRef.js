// backend/src/utils/storageRef.js
//
// M13: private document storage primitives (roadmap §5A). Pure functions, no network.
//
// A PRIVATE document is stored on Cloudinary with type "authenticated" (no public delivery URL exists). The database keeps an
// opaque reference, never a link:    cldp:<resourceType>:<format>:<publicId>
// A reference is turned into a short-lived link only by the audited access endpoint (services/documentAccess.service.js).
'use strict';

const PRIVATE_PREFIX = 'cldp:';
/** What API responses carry in place of a document link: truthy (so "uploaded" badges keep working) but not fetchable. */
const PRIVATE_MARKER = 'private://document';

const RESOURCE_TYPES = ['image', 'raw', 'video'];
const PUBLIC_ID_RE = /^runserv\/[A-Za-z0-9._\-/]{1,300}$/;

const makePrivateRef = ({ resourceType = 'image', format = '', publicId }) => {
  if (!RESOURCE_TYPES.includes(resourceType)) throw new Error('bad resource type');
  if (!PUBLIC_ID_RE.test(publicId) || publicId.includes('..') || publicId.includes('//')) throw new Error('bad public id');
  if (format && !/^[a-z0-9]{1,6}$/.test(format)) throw new Error('bad format');
  return `${PRIVATE_PREFIX}${resourceType}:${format || '-'}:${publicId}`;
};

/** @returns {{resourceType:string, format:string, publicId:string}|null} */
const parsePrivateRef = (ref) => {
  if (typeof ref !== 'string' || ref.length > 400 || !ref.startsWith(PRIVATE_PREFIX)) return null;
  const parts = ref.slice(PRIVATE_PREFIX.length).split(':');
  if (parts.length < 3) return null;
  const [resourceType, fmt, ...rest] = parts;
  const publicId = rest.join(':');
  if (!RESOURCE_TYPES.includes(resourceType)) return null;
  if (fmt !== '-' && !/^[a-z0-9]{1,6}$/.test(fmt)) return null;
  if (!PUBLIC_ID_RE.test(publicId) || publicId.includes('..') || publicId.includes('//')) return null;
  return { resourceType, format: fmt === '-' ? '' : fmt, publicId };
};

const isPrivateRef = (v) => parsePrivateRef(v) !== null;
const isPrivateMarker = (v) => v === PRIVATE_MARKER;

// Folders that hold identity / vehicle-compliance documents. Everything else (profile photos, vehicle photos, helmet photo,
// support attachments, delivery proof) stays on ordinary public delivery because riders/customers are shown those.
const SENSITIVE_FOLDER_RE = /^runserv\/(kyc\/(photos|ids|insurance|roadworthy|address|guarantor|inspection|permits|license)|documents(\/(licenses|insurance|ids|vehicles))?|partner-documents|fleet\/documents)$/;
const isSensitiveFolder = (folder) => SENSITIVE_FOLDER_RE.test(String(folder || ''));

// The profile columns that hold a document link. Responses never carry their raw value (middleware/scrubDocumentUrls.js).
const DOC_URL_FIELDS = [
  'licenseImageUrl', 'govtIdUrl', 'idImageUrl', 'proofOfAddressUrl', 'applicantPhotoUrl',
  'insuranceUrl', 'vehicleRegUrl', 'roadWorthinessUrl', 'vehicleInspectionUrl', 'hackneyCertUrl',
  'dispatchPermitUrl', 'operatorPermitUrl', 'riderCardUrl', 'guarantorLetterUrl', 'guarantorIdUrl',
  'fileUrl', // FleetPartnerDocument
];

/** Identify a file by its first bytes — never by file name or the client-supplied MIME header. */
const sniffFileType = (buf) => {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
};

const MAX_BYTES = 5 * 1024 * 1024;
/** data:<mime>;base64,<...> -> { claimedMime, buffer }, or null when malformed. */
const decodeDataUri = (uri) => {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(uri || ''));
  if (!m) return null;
  return { claimedMime: m[1].toLowerCase(), buffer: Buffer.from(m[2], 'base64') };
};

/**
 * Validate an upload's real content. Returns { ok:true, mime, ext, buffer } or { ok:false, code, message }.
 * The sniffed type must be allowed AND agree with the claimed MIME (when one was claimed).
 */
const validateUpload = ({ buffer, claimedMime = null, maxBytes = MAX_BYTES }) => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { ok: false, code: 'EMPTY_FILE', message: 'The file is empty.' };
  if (buffer.length > maxBytes) return { ok: false, code: 'FILE_TOO_LARGE', message: `File is too large (${Math.round(maxBytes / 1048576)} MB maximum).` };
  const t = sniffFileType(buffer);
  if (!t) return { ok: false, code: 'FILE_TYPE_NOT_ALLOWED', message: 'Only JPEG, PNG, WebP or PDF files can be uploaded.' };
  if (claimedMime && claimedMime !== t.mime && !(claimedMime === 'image/jpg' && t.mime === 'image/jpeg')) {
    return { ok: false, code: 'FILE_TYPE_MISMATCH', message: 'The file content does not match its declared type.' };
  }
  return { ok: true, mime: t.mime, ext: t.ext, buffer };
};

/**
 * Pure. Turn a LEGACY public Cloudinary URL into the parts needed to move it to authenticated storage, or null.
 * https://res.cloudinary.com/<cloud>/image/upload/[transformations/][v123/]runserv/kyc/ids/abc.jpg
 */
const legacyUrlToParts = (url) => {
  const m = /^https:\/\/res\.cloudinary\.com\/([^/?#]+)\/(image|raw|video)\/upload\/([^?#]+)$/i.exec(String(url || ''));
  if (!m) return null;
  const i = m[3].indexOf('runserv/');
  if (i < 0) return null;
  let id = m[3].slice(i);
  let format = '';
  if (m[2].toLowerCase() === 'image') { const d = /\.([a-z0-9]{1,5})$/i.exec(id); if (d) { format = d[1].toLowerCase(); id = id.slice(0, -d[0].length); } }
  try { makePrivateRef({ resourceType: m[2].toLowerCase(), format, publicId: id }); } catch { return null; }
  return { cloud: m[1], resourceType: m[2].toLowerCase(), format, publicId: id };
};

module.exports = {
  legacyUrlToParts,
  PRIVATE_PREFIX, PRIVATE_MARKER, DOC_URL_FIELDS, MAX_BYTES,
  makePrivateRef, parsePrivateRef, isPrivateRef, isPrivateMarker, isSensitiveFolder,
  sniffFileType, decodeDataUri, validateUpload,
};
