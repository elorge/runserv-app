// What each staff role may see of a driver / delivery-partner profile. Admins and Super Admins see everything;
// Support and Moderator staff see operational facts only (no identity documents, licence number, guarantor papers,
// live location or wallet balance).
'use strict';
const FULL_ROLES = ['ADMIN', 'SUPER_ADMIN'];
const HIDDEN = [
  'licenseNumber', 'licenseImageUrl', 'govtIdUrl', 'idImageUrl', 'proofOfAddressUrl', 'guarantorLetterUrl', 'guarantorIdUrl',
  'insuranceUrl', 'vehicleRegUrl', 'roadWorthinessUrl', 'vehicleInspectionUrl', 'hackneyCertUrl', 'dispatchPermitUrl', 'operatorPermitUrl',
  'riderCardUrl', 'applicantPhotoUrl', 'currentLat', 'currentLng',
];
const redactProfile = (profile, role) => {
  if (!profile || FULL_ROLES.includes(role)) return profile;
  const out = { ...profile };
  for (const k of HIDDEN) delete out[k];
  return out;
};
const redactUserForRole = (user, role) => {
  if (!user || FULL_ROLES.includes(role)) return user;
  const { wallet, ...rest } = user;
  return { ...rest, driverProfile: redactProfile(user.driverProfile, role), deliveryProfile: redactProfile(user.deliveryProfile, role) };
};
module.exports = { redactProfile, redactUserForRole, HIDDEN, FULL_ROLES };
