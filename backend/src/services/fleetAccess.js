// backend/src/services/fleetAccess.js
//
// Who may do what in a Fleet Partner's portal (blueprint §4.4). Enforced on the API; the UI only
// mirrors it. Every query is scoped by the caller's fleetPartnerId, so one fleet can never read
// another fleet's data (object-level isolation).
//
//   OWNER          everything for their fleet
//   ADMIN          everything except transferring ownership
//   FLEET_MANAGER  drivers, vehicles, assignments, availability, trips, reports
//   OPERATIONS     daily assignments + trip exceptions; NO finance, NO identity documents
//   FINANCE        statements, settlements, financial reports; NO driver identity documents
//   VIEWER         read-only overview, vehicles, trips
'use strict';

const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');

const ALL = ['OWNER', 'ADMIN', 'FLEET_MANAGER', 'OPERATIONS', 'FINANCE', 'VIEWER'];

const CAN = {
  view:            ALL,
  manageUsers:     ['OWNER', 'ADMIN'],
  manageSettings:  ['OWNER', 'ADMIN'],
  manageVehicles:  ['OWNER', 'ADMIN', 'FLEET_MANAGER'],
  manageDocuments: ['OWNER', 'ADMIN', 'FLEET_MANAGER'],
  assignDrivers:   ['OWNER', 'ADMIN', 'FLEET_MANAGER', 'OPERATIONS'],
  seeTrips:        ['OWNER', 'ADMIN', 'FLEET_MANAGER', 'OPERATIONS', 'FINANCE', 'VIEWER'],
  seeFinance:      ['OWNER', 'ADMIN', 'FINANCE'],
  viewDocuments:   ['OWNER', 'ADMIN', 'FLEET_MANAGER'], // M13: opening a stored identity / vehicle document (audited)
  seeDriverIdentity: ['OWNER', 'ADMIN', 'FLEET_MANAGER'], // licence numbers, phone, ID documents
};

const can = (member, action) => Boolean(member && CAN[action]?.includes(member.role));

const assertCan = (member, action) => {
  if (!can(member, action)) throw new AppError('You do not have permission to do that in this fleet.', 403);
};

/** The signed-in user's active membership of a fleet (optionally a specific one), with the fleet. */
const getMembership = (userId, fleetPartnerId) =>
  prisma.fleetPartnerUser.findFirst({
    where: { userId, isActive: true, ...(fleetPartnerId && { fleetPartnerId }) },
    include: { fleetPartner: true },
    orderBy: { createdAt: 'asc' },
  });

/** Writes that put vehicles/drivers into service need an approved (ACTIVE) fleet account. */
const assertFleetActive = (member) => {
  if (member.fleetPartner.status !== 'ACTIVE')
    throw new AppError('Your fleet account is not active yet. Runserv must approve it first.', 403);
};

/** Express middleware: loads req.fleet = { member, fleetPartner, fleetPartnerId } or 403. */
const loadMember = async (req, res, next) => {
  const member = await getMembership(req.user.id);
  if (!member) return res.status(403).json({ success: false, message: 'You do not have a fleet partner account.' });
  req.fleet = { member, fleetPartner: member.fleetPartner, fleetPartnerId: member.fleetPartnerId };
  return next();
};

/** Express middleware factory: require a permission from CAN. */
const need = (action) => (req, res, next) => {
  if (!can(req.fleet?.member, action))
    return res.status(403).json({ success: false, message: 'You do not have permission to do that in this fleet.' });
  return next();
};

module.exports = { CAN, can, assertCan, getMembership, assertFleetActive, loadMember, need };
