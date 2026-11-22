// backend/src/middleware/errorHandler.js
const { logger } = require('../utils/logger');

/**
 * Custom error class for application errors
 */
class AppError extends Error {
  constructor(message, statusCode = 500, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
    
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Global error handling middleware
 */
// Codes that are safe and useful for a client to see (never provider errors, SQL codes such as P2002, or internals).
const PUBLIC_ERROR_CODE = /^(ORG_|PHONE_|LOCATION_|GUEST_|OTP_|QUOTE_|POD_|PARCEL_|RECIPIENT_|IDEMPOTENCY_|VEHICLE_UNAVAILABLE|COUNTRY_MISMATCH|ADDRESS_REQUIRED|ACTIVE_BOOKING_EXISTS|BOOKING_|TRACKING_|NOT_CANCELLABLE|ALREADY_CONVERTED|ACCOUNT_EXISTS|EMAIL_TAKEN|WEAK_PASSWORD|INVALID_EMAIL|INVALID_PHONE|ROUTE_UNAVAILABLE|PROHIBITED_ACK_REQUIRED|FAIL_REASON_REQUIRED|NOT_IN_TRANSIT|BAD_STATUS|ALREADY_FAILED|ALREADY_DELIVERED|UNSUPPORTED_COUNTRY)/;

const errorHandler = (err, req, res, next) => {
  let error = { ...err };
  error.message = err.message;
  error.statusCode = err.statusCode || 500;

  // Log error
  logger.error({
    message: error.message,
    stack: err.stack,
    statusCode: error.statusCode,
    path: req.path,
    method: req.method
  });

  // Prisma errors
  if (err.code === 'P2002') {
    error.message = 'That value is already in use.'; // never echo column names back to the client
    error.statusCode = 400;
  }

  if (err.code === 'P2025') {
    error.message = 'Record not found';
    error.statusCode = 404;
  }

  // Validation errors
  if (err.name === 'ValidationError') {
    const message = Object.values(err.errors).map(val => val.message);
    error.message = message.join(', ');
    error.statusCode = 400;
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    error.message = 'Invalid token';
    error.statusCode = 401;
  }

  if (err.name === 'TokenExpiredError') {
    error.message = 'Token expired';
    error.statusCode = 401;
  }

  // Never leak internals: an unexpected (non-AppError) failure returns a generic message outside development, so SQL,
  // file paths or provider error text cannot reach a client. The full detail is already in the server log above.
  const isDev = ['development', 'test'].includes(String(process.env.NODE_ENV || '').toLowerCase());
  if (error.statusCode >= 500 && !err.isOperational && !isDev) error.message = 'Something went wrong. Please try again.';

  // Send error response
  res.status(error.statusCode).json({
    success: false,
    message: error.message,
    // Machine-readable code for organisation (ORG_*), phone (PHONE_*) and location-consent (LOCATION_*) errors so the apps can react to them.
    // M15: also the guest-booking / OTP / quote / proof-of-delivery codes (the guest and courier screens branch on them), plus the
    // number of wrong-code attempts left. Only these fixed, non-sensitive codes are exposed; any other error code stays server-side.
    ...(typeof err.code === 'string' && PUBLIC_ERROR_CODE.test(err.code) && { code: err.code, ...(err.details && { details: err.details }) }),
    ...(typeof err.code === 'string' && PUBLIC_ERROR_CODE.test(err.code) && Number.isFinite(err.attemptsLeft) && { attemptsLeft: err.attemptsLeft }),
    ...(isDev && process.env.NODE_ENV === 'development' && { stack: err.stack })
  });

  // FUTURE: Send critical errors to monitoring service
  // if (!error.isOperational) {
  //   sendToSentry(error);
  // }
};

/**
 * Async error wrapper for route handlers
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = {
  AppError,
  errorHandler,
  asyncHandler
};