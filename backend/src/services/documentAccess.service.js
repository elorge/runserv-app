// backend/src/services/documentAccess.service.js
//
// M13 (roadmap Phase 1 / §5A): the ONLY way to open a stored identity or vehicle document.
// authenticate -> authorise (viewDocuments rule below) -> audit (granted AND denied) -> short-lived signed link.
//
//   Runserv staff : SUPER_ADMIN; ADMIN with no department, or the department that owns the source
//                   (RIDES -> driver profiles & fleet documents, DELIVERIES -> delivery-partner profiles), inside their markets.
//                   SUPPORT / MODERATOR / FINANCE-type staff NEVER (matches lib/redactProfile.js).
//   The owner     : a driver / courier opening their own file.
//   Fleet members : fleetAccess CAN.viewDocuments (OWNER, ADMIN, FLEET_MANAGER) for their OWN fleet's documents, and
//                   CAN.seeDriverIdentity for a driver with an ACTIVE assignment to their fleet. OPERATIONS, FINANCE, VIEWER: never.
'use strict';

const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { logActivity } = require('../utils/auditLog');
const { DOC_URL_FIELDS, parsePrivateRef } = require('../utils/storageRef');
const { canActInMarket } = require('../utils/marketScope');
const fleetAccess = require('./fleetAccess');
const upload = require('./upload.service');

const PROFILE_FIELDS = DOC_URL_FIELDS.filter((f) => f !== 'fileUrl');
const SOURCES = {
  DRIVER_PROFILE:   { model: 'driverProfile',          fields: PROFILE_FIELDS, dept: 'RIDES',      owned: true },
  DELIVERY_PROFILE: { model: 'deliveryPartnerProfile', fields: PROFILE_FIELDS, dept: 'DELIVERIES', owned: true },
  FLEET_DOCUMENT:   { model: 'fleetPartnerDocument',   fields: ['fileUrl'],    dept: 'RIDES',      owned: false },
};

/** Pure: may this staff member open documents of this source? */
const staffMayView = (user, cfg, countryCode) => {
  if (user.role === 'SUPER_ADMIN') return true;
  if (user.role !== 'ADMIN') return false;
  if (user.adminDepartment && user.adminDepartment !== cfg.dept) return false;
  return cfg.owned ? canActInMarket(user, countryCode) : true;
};

const decide = async ({ user, cfg, source, record }) => {
  if (['ADMIN', 'SUPER_ADMIN'].includes(user.role) && staffMayView(user, cfg, record.user?.countryCode)) return { allowed: true, scope: 'STAFF' };
  if (cfg.owned && record.userId === user.id) return { allowed: true, scope: 'OWNER' };
  const member = await fleetAccess.getMembership(user.id);
  if (member) {
    if (source === 'FLEET_DOCUMENT' && record.fleetPartnerId === member.fleetPartnerId && fleetAccess.can(member, 'viewDocuments')) return { allowed: true, scope: 'FLEET' };
    if (source === 'DRIVER_PROFILE' && fleetAccess.can(member, 'seeDriverIdentity')) {
      const a = await prisma.fleetDriverAssignment.findFirst({ where: { driverUserId: record.userId, fleetPartnerId: member.fleetPartnerId, status: 'ACTIVE' }, select: { id: true } });
      if (a) return { allowed: true, scope: 'FLEET' };
    }
  }
  return { allowed: false };
};

/**
 * @returns {Promise<{url:string, expiresAt:string|null, legacy:boolean}>}
 * `legacy` = the file predates M13 and is still on public delivery (run scripts/migrate-documents-private.js).
 */
const requestDocumentAccess = async ({ user, source, id, field, reason, req, signer = upload.signedPrivateUrl }) => {
  const cfg = SOURCES[source];
  if (!cfg || !cfg.fields.includes(field)) throw new AppError('Unknown document.', 400);
  const record = await prisma[cfg.model].findUnique({ where: { id }, ...(cfg.owned && { include: { user: { select: { countryCode: true } } } }) });
  // Same answer for "no such record" and "not yours" so ids cannot be probed.
  const audit = (action, details) => logActivity({ userId: user.id, action, entityType: cfg.model, entityId: id, details: { source, field, reason: reason ? String(reason).slice(0, 200) : null, ...details }, req });
  if (!record) { await audit('document_access_denied', { why: 'not_found' }); throw new AppError('Document not found.', 404); }
  const d = await decide({ user, cfg, source, record });
  if (!d.allowed) { await audit('document_access_denied', { why: 'forbidden', role: user.role }); throw new AppError('Document not found.', 404); }
  const value = record[field];
  if (!value) throw new AppError('No document on file.', 404);
  await audit('document_accessed', { scope: d.scope });
  const ref = parsePrivateRef(value);
  if (!ref) return { url: value, expiresAt: null, legacy: true };
  return { ...signer(ref), legacy: false, format: ref.format || null };
};

module.exports = { SOURCES, staffMayView, requestDocumentAccess };
