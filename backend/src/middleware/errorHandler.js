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
    // Machine-readable code for organisation (ORG_*), phone (PHONE_*) and location-consent (LOCATION_*) errors so the apps can react to them
    ...(typeof err.code === 'string' && /^(ORG_|PHONE_|LOCATION_)/.test(err.code) && { code: err.code, ...(err.details && { details: err.details }) }),
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