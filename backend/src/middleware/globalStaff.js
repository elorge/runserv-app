// backend/src/middleware/globalStaff.js
// Fleet and bank-partner administration are platform-wide commercial resources (commission rates, bank
// agreements, settlements). A staff member limited to specific countries must not reach them, even
// though they are an ADMIN. Super Admin and unrestricted admins pass.
'use strict';
const { staffMarkets } = require('../utils/marketScope');

module.exports = (req, res, next) => {
  if (staffMarkets(req.user).length > 0) {
    return res.status(403).json({ success: false, message: 'This area is not available to country-limited staff accounts.' });
  }
  return next();
};
