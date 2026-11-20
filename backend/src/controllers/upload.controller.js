// backend/src/controllers/upload.controller.js
const uploadService = require('../services/upload.service');
const { AppError } = require('../middleware/errorHandler');
const { decodeDataUri, validateUpload, isSensitiveFolder } = require('../utils/storageRef');

/**
 * @desc    Upload profile image
 * @route   POST /api/upload/profile-image
 * @access  Private
 */
exports.uploadProfileImage = async (req, res) => {
  if (!req.file) {
    throw new AppError('No file uploaded', 400);
  }

  res.status(200).json({
    success: true,
    message: 'Profile image uploaded successfully',
    data: {
      url: req.file.path,
      publicId: req.file.filename
    }
  });
};

/**
 * @desc    Upload driver license
 * @route   POST /api/upload/driver/license
 * @access  Private (DRIVER)
 */
exports.uploadDriverLicense = async (req, res) => {
  if (!req.privateFile) {
    throw new AppError('No file uploaded', 400);
  }

  res.status(200).json({
    success: true,
    message: 'License uploaded successfully',
    data: {
      url: req.privateFile.ref, private: true,
      publicId: req.privateFile.publicId
    }
  });
};

/**
 * @desc    Upload vehicle registration
 * @route   POST /api/upload/driver/vehicle-registration
 * @access  Private (DRIVER)
 */
exports.uploadVehicleRegistration = async (req, res) => {
  if (!req.privateFile) {
    throw new AppError('No file uploaded', 400);
  }

  res.status(200).json({
    success: true,
    message: 'Vehicle registration uploaded successfully',
    data: {
      url: req.privateFile.ref, private: true,
      publicId: req.privateFile.publicId
    }
  });
};

/**
 * @desc    Upload insurance document
 * @route   POST /api/upload/driver/insurance
 * @access  Private (DRIVER)
 */
exports.uploadInsurance = async (req, res) => {
  if (!req.privateFile) {
    throw new AppError('No file uploaded', 400);
  }

  res.status(200).json({
    success: true,
    message: 'Insurance document uploaded successfully',
    data: {
      url: req.privateFile.ref, private: true,
      publicId: req.privateFile.publicId
    }
  });
};

/**
 * @desc    Upload partner ID
 * @route   POST /api/upload/partner/id
 * @access  Private (DELIVERY_PARTNER)
 */
exports.uploadPartnerId = async (req, res) => {
  if (!req.privateFile) {
    throw new AppError('No file uploaded', 400);
  }

  res.status(200).json({
    success: true,
    message: 'ID uploaded successfully',
    data: {
      url: req.privateFile.ref, private: true,
      publicId: req.privateFile.publicId
    }
  });
};

/**
 * @desc    Upload partner vehicle image
 * @route   POST /api/upload/partner/vehicle
 * @access  Private (DELIVERY_PARTNER)
 */
exports.uploadPartnerVehicle = async (req, res) => {
  if (!req.file) {
    throw new AppError('No file uploaded', 400);
  }

  res.status(200).json({
    success: true,
    message: 'Vehicle image uploaded successfully',
    data: {
      url: req.file.path,
      publicId: req.file.filename
    }
  });
};

/**
 * @desc    Upload delivery proof image
 * @route   POST /api/upload/delivery/proof
 * @access  Private (DELIVERY_PARTNER)
 */
exports.uploadDeliveryProof = async (req, res) => {
  if (!req.file) {
    throw new AppError('No file uploaded', 400);
  }

  res.status(200).json({
    success: true,
    message: 'Delivery proof uploaded successfully',
    data: {
      url: req.file.path,
      publicId: req.file.filename
    }
  });
};

/**
 * @desc    Upload from base64 (for mobile apps)
 * @route   POST /api/upload/base64
 * @access  Private
 */
exports.uploadBase64 = async (req, res) => {
  const { base64Data, folder } = req.body;

  if (!base64Data) {
    throw new AppError('No base64 data provided', 400);
  }

  // Only real image/PDF data-URIs (never a URL, which the storage provider would fetch for us), a size cap, and a fixed
  // allow-list of folders. The fleet-documents folder is reserved for the fleet upload route, so a user cannot plant a
  // file there that the "trusted link" check would then accept.
  const uri = String(base64Data);
  if (!/^data:(image\/(jpeg|png|webp)|application\/pdf);base64,/.test(uri)) throw new AppError('Only JPEG, PNG, WebP or PDF files can be uploaded.', 400);
  if (uri.length > 7 * 1024 * 1024) throw new AppError('File is too large (5 MB maximum).', 413);
  const ALLOWED = ['runserv/general', 'runserv/documents', 'runserv/partner-documents', 'runserv/profile', 'runserv/support', 'runserv/kyc/photos', 'runserv/kyc/ids', 'runserv/kyc/insurance', 'runserv/kyc/roadworthy', 'runserv/kyc/address', 'runserv/kyc/guarantor', 'runserv/kyc/helmet', 'runserv/kyc/inspection', 'runserv/kyc/permits', 'runserv/kyc/vehicles', 'runserv/kyc/license'];
  const target = folder === undefined || folder === null || folder === '' ? 'runserv/general' : String(folder);
  if (!ALLOWED.includes(target)) throw new AppError('That upload folder is not allowed.', 400);
  // M13: validate the REAL bytes (not the declared type), and keep identity / compliance documents PRIVATE.
  const decoded = decodeDataUri(uri);
  if (!decoded) throw new AppError('Malformed upload.', 400);
  const v = validateUpload({ buffer: decoded.buffer, claimedMime: decoded.claimedMime });
  if (!v.ok) throw new AppError(v.message, v.code === 'FILE_TOO_LARGE' ? 413 : 400);
  if (isSensitiveFolder(target)) {
    const p = await uploadService.uploadPrivateBuffer(v, target);
    return res.status(200).json({ success: true, message: 'File uploaded successfully', data: { url: p.ref, publicId: p.publicId, private: true } });
  }
  const result = await uploadService.uploadBase64(uri, target);

  res.status(200).json({
    success: true,
    message: 'File uploaded successfully',
    data: result
  });
};

/**
 * @desc    Delete uploaded file
 * @route   DELETE /api/upload/:publicId
 * @access  Private
 */
exports.deleteFile = async (req, res) => {
  // Files carry no owner record here, so only Runserv staff may delete one (any signed-in user could previously delete
  // anyone's licence or document by its id).
  if (!['ADMIN', 'SUPER_ADMIN'].includes(req.user.role)) throw new AppError('Not allowed.', 403);
  const { publicId } = req.params;
  if (!/^runserv\//.test(decodeURIComponent(publicId))) throw new AppError('Not allowed.', 403);

  await uploadService.deleteFile(decodeURIComponent(publicId));

  res.status(200).json({
    success: true,
    message: 'File deleted successfully'
  });
};

module.exports = exports;