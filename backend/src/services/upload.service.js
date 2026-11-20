// backend/src/services/upload.service.js
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
// Note: multer-storage-cloudinary v4 works with cloudinary v2 despite the peer warning
const path = require('path');
const crypto = require('crypto');
const { makePrivateRef, parsePrivateRef, validateUpload, MAX_BYTES } = require('../utils/storageRef');
const { AppError } = require('../middleware/errorHandler');

// ─── Configure Cloudinary ─────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ─── Helper: pick folder from request path ────────────────────────────────────
const getFolderFromPath = (reqPath) => {
  if (reqPath.includes('documents/upload'))     return 'runserv/fleet/documents';
  if (reqPath.includes('license'))              return 'runserv/documents/licenses';
  if (reqPath.includes('vehicle-registration')) return 'runserv/documents/vehicles';
  if (reqPath.includes('insurance'))            return 'runserv/documents/insurance';
  if (reqPath.includes('profile'))              return 'runserv/profiles';
  if (reqPath.includes('delivery'))             return 'runserv/deliveries/proof';
  if (reqPath.includes('partner/id'))           return 'runserv/documents/ids';
  if (reqPath.includes('partner/vehicle'))      return 'runserv/documents/vehicles';
  return 'runserv/general';
};

// ─── Cloudinary storage (multer-storage-cloudinary v5) ───────────────────────
// v5 changed: params must be a plain object or async fn returning plain object.
// transformation is now a top-level key, not nested inside params.
const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder:          getFolderFromPath(req.path),
    allowed_formats: ['jpg', 'jpeg', 'png', 'pdf'],
    public_id:       `${Date.now()}-${path.parse(file.originalname).name}`,
    transformation:  [{ width: 1000, height: 1000, crop: 'limit' }],
  }),
});

// ─── File filter ─────────────────────────────────────────────────────────────
const fileFilter = (req, file, cb) => {
  const allowed = /jpeg|jpg|png|pdf/;
  const validExt  = allowed.test(path.extname(file.originalname).toLowerCase());
  const validMime = allowed.test(file.mimetype);

  if (validExt && validMime) {
    cb(null, true);
  } else {
    cb(new AppError('Only JPEG, PNG, and PDF files are allowed', 400));
  }
};

// ─── Multer instance ──────────────────────────────────────────────────────────
// multer v2: `limits.fileSize` API is unchanged; fileFilter signature is unchanged.
const upload = multer({
  storage,
  limits:     { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter,
});

// ─── Exported middleware factories ────────────────────────────────────────────

/**
 * Single-file upload middleware
 * @param {string} fieldName — form field name
 */
exports.uploadSingle = (fieldName) => upload.single(fieldName);

/**
 * Multi-file upload middleware
 * @param {string} fieldName
 * @param {number} maxCount
 */
exports.uploadMultiple = (fieldName, maxCount = 10) =>
  upload.array(fieldName, maxCount);

// ─── Direct Cloudinary helpers ────────────────────────────────────────────────

/**
 * Upload a base64 data-URI directly (used by mobile /upload/base64 endpoint)
 */
exports.uploadBase64 = async (base64Data, folder = 'runserv/general') => {
  try {
    const result = await cloudinary.uploader.upload(base64Data, {
      folder,
      resource_type: 'auto',
    });
    return { url: result.secure_url, publicId: result.public_id };
  } catch (err) {
    throw new AppError('Failed to upload file: ' + err.message, 500);
  }
};

/**
 * Delete a file from Cloudinary by public_id
 */
exports.deleteFile = async (publicId) => {
  try {
    return await cloudinary.uploader.destroy(publicId);
  } catch (err) {
    throw new AppError('Failed to delete file: ' + err.message, 500);
  }
};

/**
 * Build a signed/transformed URL for an existing public_id
 */
exports.getFileUrl = (publicId, options = {}) =>
  cloudinary.url(publicId, { secure: true, ...options });

// ─── M13: PRIVATE document storage ────────────────────────────────────────────
// Identity and vehicle-compliance files are stored with Cloudinary type "authenticated": there is NO public URL. The database
// keeps an opaque reference (utils/storageRef.js); a short-lived link is issued only by services/documentAccess.service.js.

/** @param {{buffer:Buffer, ext:string}} v  (output of validateUpload)  @returns {Promise<{ref:string, publicId:string}>} */
exports.uploadPrivateBuffer = async (v, folder) => {
  const publicId = `${folder}/${crypto.randomBytes(16).toString('hex')}`; // unguessable
  try {
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream({ public_id: publicId, type: 'authenticated', resource_type: 'image', overwrite: false }, (err, r) => (err ? reject(err) : resolve(r))).end(v.buffer);
    });
    return { ref: makePrivateRef({ resourceType: result.resource_type || 'image', format: result.format || v.ext, publicId: result.public_id }), publicId: result.public_id };
  } catch (err) {
    throw new AppError('Failed to upload file: ' + (err.message || 'storage error'), 500);
  }
};

const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

/** Multipart middleware for a sensitive file: reads into memory, validates the REAL bytes, stores privately, sets req.privateFile. */
exports.uploadPrivateSingle = (fieldName, folder) => [
  memUpload.single(fieldName),
  async (req, res, next) => {
    try {
      if (!req.file) return next();
      const v = validateUpload({ buffer: req.file.buffer, claimedMime: String(req.file.mimetype || '').toLowerCase() });
      if (!v.ok) throw new AppError(v.message, v.code === 'FILE_TOO_LARGE' ? 413 : 400);
      req.privateFile = await exports.uploadPrivateBuffer(v, folder);
      req.file.buffer = undefined;
      return next();
    } catch (e) { return next(e); }
  },
];

/** Short-lived download link for a private reference. */
exports.signedPrivateUrl = (ref, ttlSeconds = 120) => {
  const r = typeof ref === 'string' ? parsePrivateRef(ref) : ref;
  if (!r) throw new AppError('Not a private document reference.', 400);
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const url = cloudinary.utils.private_download_url(r.publicId, r.format || '', { type: 'authenticated', resource_type: r.resourceType, expires_at: expiresAt });
  return { url, expiresAt: new Date(expiresAt * 1000).toISOString() };
};

module.exports = exports;