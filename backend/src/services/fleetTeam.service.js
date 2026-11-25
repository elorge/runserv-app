// backend/src/services/fleetTeam.service.js — fleet team invitations and driver shifts.
// Invitations: the token is shown ONCE to the inviter and e-mailed to the invitee; only its SHA-256 is stored. Accepting needs the signed-in account's
// e-mail to match the invitation. Shifts: a schedule of driver + vehicle + period; overlaps are refused here and by database exclusion constraints.
'use strict';
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { logActivity } = require('../utils/auditLog');

const INVITE_DAYS = 7;
const MAX_SHIFT_HOURS = 24;
const ROLES = ['ADMIN', 'FLEET_MANAGER', 'OPERATIONS', 'FINANCE', 'VIEWER'];
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const conflict = (m, code) => { const e = new AppError(m, 409); e.code = code; return e; };
const acceptUrl = (token, env = process.env) => `${String(env.ADMIN_URL || env.APP_URL || '').split(',')[0].replace(/\/$/, '')}/fleet/accept-invite?token=${token}`;

const publicInvite = (i) => ({ id: i.id, email: i.email, role: i.role, status: i.status, expiresAt: i.expiresAt, createdAt: i.createdAt, acceptedAt: i.acceptedAt || null });

async function invite({ fleetPartnerId, fleetName, email, role, actor, req, now = new Date(), mailer = null }) {
  if (!ROLES.includes(role)) throw new AppError('Choose a valid role (there is one owner per fleet).', 400);
  const mail = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) throw new AppError('Enter a valid e-mail address.', 400);
  const existing = await prisma.user.findUnique({ where: { email: mail }, select: { id: true } });
  if (existing) {
    const m = await prisma.fleetPartnerUser.findFirst({ where: { userId: existing.id, isActive: true } });
    if (m) throw conflict(m.fleetPartnerId === fleetPartnerId ? 'That person is already on your team.' : 'That person already belongs to another fleet account.', 'ALREADY_MEMBER');
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const row = await prisma.$transaction(async (tx) => {
    await tx.fleetInvitation.updateMany({ where: { fleetPartnerId, email: mail, status: 'PENDING' }, data: { status: 'REVOKED' } });   // a re-invite replaces the old link
    return tx.fleetInvitation.create({ data: { fleetPartnerId, email: mail, role, tokenHash: hash(token), expiresAt: new Date(now.getTime() + INVITE_DAYS * 86400000), invitedById: actor } });
  });
  await logActivity({ userId: actor, action: 'fleet_invitation_created', entityType: 'FleetInvitation', entityId: row.id, details: { fleetPartnerId, role, email: mail }, req });
  const url = acceptUrl(token);
  let emailed = false;
  try {
    const send = mailer || require('./email.service').sendEmail;
    await send({ to: mail, subject: `You are invited to ${fleetName || 'a fleet'} on Runserv`, text: `You have been invited to join ${fleetName || 'a fleet'} on Runserv as ${role.toLowerCase().replace('_', ' ')}.\nSign in (or create an account) with this e-mail address, then open:\n${url}\nThe link expires in ${INVITE_DAYS} days.`, html: `<p>You have been invited to join <b>${String(fleetName || 'a fleet').replace(/[<>&]/g, '')}</b> on Runserv.</p><p>Sign in (or create an account) with this e-mail address, then <a href="${url}">accept the invitation</a>. The link expires in ${INVITE_DAYS} days.</p>` });
    emailed = true;
  } catch (e) { console.error('[fleet-invite] e-mail failed:', e.message); }
  return { invitation: publicInvite(row), acceptUrl: url, emailed };     // the link is returned once, to the inviter, so it can be shared if e-mail is unavailable
}

async function accept({ token, user, req, now = new Date() }) {
  const inv = await prisma.fleetInvitation.findUnique({ where: { tokenHash: hash(token || '') } });
  if (!inv || inv.status !== 'PENDING') throw new AppError('This invitation is not valid. Ask for a new one.', 404);
  if (inv.expiresAt <= now) throw new AppError('This invitation has expired. Ask for a new one.', 410);
  if (String(user.email || '').toLowerCase() !== inv.email) throw new AppError(`This invitation was sent to ${inv.email.replace(/^(.).*(@.*)$/, '$1•••$2')}. Sign in with that e-mail address.`, 403);
  const elsewhere = await prisma.fleetPartnerUser.findFirst({ where: { userId: user.id, isActive: true } });
  if (elsewhere) throw conflict('You already belong to a fleet account.', 'ALREADY_MEMBER');
  const member = await prisma.$transaction(async (tx) => {
    const claim = await tx.fleetInvitation.updateMany({ where: { id: inv.id, status: 'PENDING' }, data: { status: 'ACCEPTED', acceptedByUserId: user.id, acceptedAt: now } });
    if (claim.count !== 1) throw new AppError('This invitation was already used.', 409);
    return tx.fleetPartnerUser.upsert({
      where: { fleetPartnerId_userId: { fleetPartnerId: inv.fleetPartnerId, userId: user.id } },
      update: { role: inv.role, isActive: true, acceptedAt: now }, create: { fleetPartnerId: inv.fleetPartnerId, userId: user.id, role: inv.role, acceptedAt: now },
    });
  });
  await logActivity({ userId: user.id, action: 'fleet_invitation_accepted', entityType: 'FleetInvitation', entityId: inv.id, details: { fleetPartnerId: inv.fleetPartnerId, role: inv.role }, req });
  return member;
}

async function list(fleetPartnerId) {
  const rows = await prisma.fleetInvitation.findMany({ where: { fleetPartnerId, status: 'PENDING' }, orderBy: { createdAt: 'desc' }, take: 100 });
  return rows.map(publicInvite);
}

async function revoke({ id, fleetPartnerId, actor, req }) {
  const r = await prisma.fleetInvitation.updateMany({ where: { id, fleetPartnerId, status: 'PENDING' }, data: { status: 'REVOKED' } });
  if (r.count !== 1) throw new AppError('Pending invitation not found.', 404);
  await logActivity({ userId: actor, action: 'fleet_invitation_revoked', entityType: 'FleetInvitation', entityId: id, details: { fleetPartnerId }, req });
  return { revoked: true };
}

// ── Shifts ───────────────────────────────────────────────────────────────────
async function createShift({ fleetPartnerId, vehicleId, driverUserId, startsAt, endsAt, note, actor, req, now = new Date() }) {
  const start = new Date(startsAt); const end = new Date(endsAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) throw new AppError('Start and end must be valid date-times.', 400);
  if (end <= start) throw new AppError('The shift must end after it starts.', 400);
  if (end - start > MAX_SHIFT_HOURS * 3600000) throw new AppError(`A shift cannot be longer than ${MAX_SHIFT_HOURS} hours.`, 400);
  if (end <= now) throw new AppError('The shift is already over.', 400);
  const assignment = await prisma.fleetDriverAssignment.findFirst({ where: { fleetPartnerId, vehicleId, driverUserId, status: 'ACTIVE' }, select: { id: true } });
  if (!assignment) throw conflict('That driver is not currently assigned to that vehicle in your fleet.', 'NOT_ASSIGNED');
  try {
    const row = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'fleet-shift:' + fleetPartnerId}))`;
      const clash = await tx.fleetShift.findFirst({ where: { status: 'SCHEDULED', startsAt: { lt: end }, endsAt: { gt: start }, OR: [{ vehicleId }, { driverUserId }] }, select: { vehicleId: true } });
      if (clash) throw conflict(clash.vehicleId === vehicleId ? 'That vehicle is already on a shift in this period.' : 'That driver is already on a shift in this period.', 'SHIFT_OVERLAP');
      return tx.fleetShift.create({ data: { fleetPartnerId, vehicleId, driverUserId, startsAt: start, endsAt: end, note: note ? String(note).slice(0, 300) : null, createdById: actor } });
    });
    await logActivity({ userId: actor, action: 'fleet_shift_created', entityType: 'FleetShift', entityId: row.id, details: { fleetPartnerId, vehicleId, driverUserId, startsAt: start, endsAt: end }, req });
    return row;
  } catch (e) {
    if (e.code === '23P01' || e.meta?.code === '23P01' || (e.code === 'P2010' && /23P01/.test(String(e.message)))) throw conflict('That driver or vehicle is already on a shift in this period.', 'SHIFT_OVERLAP');
    throw e;
  }
}

async function listShifts({ fleetPartnerId, from, to, vehicleId, driverUserId, includeCancelled = false }) {
  const where = { fleetPartnerId, ...(includeCancelled ? {} : { status: 'SCHEDULED' }), ...(from && { endsAt: { gt: new Date(from) } }), ...(to && { startsAt: { lt: new Date(to) } }), ...(vehicleId && { vehicleId }), ...(driverUserId && { driverUserId }) };
  return prisma.fleetShift.findMany({ where, orderBy: { startsAt: 'asc' }, take: 500 });
}

async function cancelShift({ id, fleetPartnerId, actor, req, now = new Date() }) {
  const r = await prisma.fleetShift.updateMany({ where: { id, fleetPartnerId, status: 'SCHEDULED' }, data: { status: 'CANCELLED', cancelledById: actor, cancelledAt: now } });
  if (r.count !== 1) throw new AppError('Scheduled shift not found.', 404);
  await logActivity({ userId: actor, action: 'fleet_shift_cancelled', entityType: 'FleetShift', entityId: id, details: { fleetPartnerId }, req });
  return { cancelled: true };
}

module.exports = { invite, accept, list, revoke, createShift, listShifts, cancelShift, hash, acceptUrl, INVITE_DAYS, MAX_SHIFT_HOURS, ROLES };
