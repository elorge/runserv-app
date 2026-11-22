// backend/src/controllers/admin.controller.js
'use strict';

const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { debitWallet, creditWallet, claim, newReference } = require('../services/walletOps');
const notificationService = require('../services/notification.service');
const emailService = require('../services/email.service');
const { invalidateFareCache, getSettings } = require('../utils/fareEngine');
const bcrypt = require('bcryptjs');
const { invalidateMaintenanceCache } = require('../middleware/maintenance.middleware');
const commissionService = require('../services/commission.service');
const { validationResult } = require('express-validator');
const { getWithdrawableBalance, ensureWallet } = require('../utils/walletHelpers');
const paymentService = require('../services/payment.service');
const { logActivity } = require('../utils/auditLog');
const countrySettingsService = require('../services/countrySettings.service');
const { marketWhere, scopeOnlyWhere, canActInMarket, tallyByCountry, staffMarkets, hasCountryAuthority, staffInsideMarkets } = require('../utils/marketScope');
const { formatMoney, isWholeUnitCurrency } = require('../utils/currency');
const { SUPPORTED_LANGUAGES, normalizeLanguage, tr } = require('../utils/supportI18n');
const { ticketScopeWhere, canAccessTicket } = require('../utils/supportRouting');

// Onboarding bonus for one earner: an explicit admin override wins, otherwise
// the bonus configured for the earner's own country (in that country's currency).
const bonusFor = async (kind, countryCode, override) => {
  if (override !== undefined && override !== null && override !== '') return Number(override);
  return countrySettingsService.getSetting(countryCode ?? 'NG', kind === 'driver' ? 'onboarding_bonus_driver' : 'onboarding_bonus_partner');
};

// Small helper so a failed email never blocks (or rolls back) an approval/
// rejection that has already been committed to the DB. Approval status is
// the source of truth — email is a best-effort notification on top of it.
const safeSendEmail = async (fn, label) => {
  try {
    await fn();
  } catch (err) {
    console.error(`[admin.controller] ${label} email failed to send:`, err.message);
  }
};

async function fetchBonusCandidates(market) {
  const scoped = market ? { user: market } : {};
  const [allDrivers, allPartners] = await Promise.all([
    prisma.driverProfile.findMany({
      where:   { isApproved: true, ...scoped },
      include: {
        user: {
          include: {
            wallet: {
              include: {
                transactions: {
                  where: { reference: { startsWith: 'ONBOARDING-DRV-' } },
                  select: { id: true },
                  take: 1,
                },
              },
            },
          },
        },
      },
    }),
    prisma.deliveryPartnerProfile.findMany({
      where:   { isApproved: true, ...scoped },
      include: {
        user: {
          include: {
            wallet: {
              include: {
                transactions: {
                  where: { reference: { startsWith: 'ONBOARDING-PTR-' } },
                  select: { id: true },
                  take: 1,
                },
              },
            },
          },
        },
      },
    }),
  ]);
 
  // Eligible = has a wallet AND has never received an onboarding bonus transaction
  const driversEligible  = allDrivers.filter(d =>
    d.user.wallet && d.user.wallet.transactions.length === 0
  );
  const partnersEligible = allPartners.filter(p =>
    p.user.wallet && p.user.wallet.transactions.length === 0
  );
 
  return { allDrivers, allPartners, driversEligible, partnersEligible };
}
 
// ─────────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────────

exports.getDashboardStats = async (req, res) => {
  // Optional ?country=ML scopes the whole dashboard to one market. Staff with assigned
  // countries are always confined to them. Money is NEVER added across currencies:
  // amounts come back per currency, with a "primary" one for the single-figure cards.
  const market      = marketWhere(req.user, req.query.country);   // { countryCode } | undefined
  const countryCode = market && typeof market.countryCode === 'string' ? market.countryCode : null;
  const uW          = market ? { ...market } : {};                // User / SupportTicket
  const viaCustomer = market ? { customer: market } : {};         // Ride / Delivery
  const viaUser     = market ? { user: market } : {};             // Payment

  const todayStart     = new Date(); todayStart.setHours(0, 0, 0, 0);
  const yesterdayStart = new Date(todayStart); yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const monthStart     = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const weekStart      = new Date(); weekStart.setDate(weekStart.getDate() - 7); weekStart.setHours(0, 0, 0, 0);
  const yearStart      = new Date(new Date().getFullYear(), 0, 1);

  const paid = (createdAt) => prisma.payment.groupBy({
    by: ['currency'],
    where: { status: 'COMPLETED', ...viaUser, ...(createdAt ? { createdAt } : {}) },
    _sum: { amount: true },
  });

  const [
    totalUsers, totalDrivers, totalPartners,
    totalRides, totalDeliveries, activeRides, activeDeliveries,
    todayRevenue, yesterdayRevenue, monthRevenue, weekRevenue, yearRevenue, walletRows,
    pendingDrivers, pendingPartners, openTickets,
    newUsersToday, newUsersYesterday,
    suspendedDriversCount, suspendedPartnersCount,
    suspendedDriversList, suspendedPartnersList,
    countryRow,
  ] = await Promise.all([
    prisma.user.count({ where: { role: 'CUSTOMER', ...uW } }),
    prisma.user.count({ where: { role: 'DRIVER', ...uW } }),
    prisma.user.count({ where: { role: 'DELIVERY_PARTNER', ...uW } }),
    prisma.ride.count({ where: { status: 'COMPLETED', ...viaCustomer } }),
    prisma.delivery.count({ where: { status: 'DELIVERED', ...viaCustomer } }),
    prisma.ride.count({ where: { status: { in: ['REQUESTED', 'ACCEPTED', 'ARRIVED', 'IN_PROGRESS'] }, ...viaCustomer } }),
    prisma.delivery.count({ where: { status: { in: ['PENDING', 'ASSIGNED', 'PICKED_UP', 'IN_TRANSIT'] }, ...viaCustomer } }),

    paid({ gte: todayStart }),
    paid({ gte: yesterdayStart, lt: todayStart }),
    paid({ gte: monthStart }),
    paid({ gte: weekStart }),
    paid({ gte: yearStart }),

    prisma.wallet.groupBy({
      by: ['currency'],
      where: { user: { role: { in: ['CUSTOMER', 'DRIVER', 'DELIVERY_PARTNER'] }, isActive: true, ...uW } },
      _sum: { balance: true },
    }),
    prisma.driverProfile.count({ where: { isApproved: false, isRejected: false, ...(market ? { user: market } : {}) } }),
    prisma.deliveryPartnerProfile.count({ where: { isApproved: false, isRejected: false, ...(market ? { user: market } : {}) } }),
    prisma.supportTicket.count({ where: { status: 'open', ...uW } }),

    prisma.user.count({ where: { createdAt: { gte: todayStart }, ...uW } }),
    prisma.user.count({ where: { createdAt: { gte: yesterdayStart, lt: todayStart }, ...uW } }),

    prisma.user.count({ where: { role: 'DRIVER', isSuspended: true, ...uW } }),
    prisma.user.count({ where: { role: 'DELIVERY_PARTNER', isSuspended: true, ...uW } }),
    prisma.user.findMany({
      where: { role: 'DRIVER', isSuspended: true, ...uW },
      select: { id: true, firstName: true, lastName: true, email: true, phone: true, suspendedAt: true, suspensionReason: true },
      orderBy: { suspendedAt: 'desc' },
      take: 10,
    }),
    prisma.user.findMany({
      where: { role: 'DELIVERY_PARTNER', isSuspended: true, ...uW },
      select: { id: true, firstName: true, lastName: true, email: true, phone: true, suspendedAt: true, suspensionReason: true },
      orderBy: { suspendedAt: 'desc' },
      take: 10,
    }),
    countryCode ? prisma.country.findUnique({ where: { code: countryCode }, select: { code: true, name: true, currencyCode: true } }) : null,
  ]);

  // ── Money, one row per currency ─────────────────────────────────────────────
  const byCur = {};
  const row = (c) => (byCur[c] ??= { currency: c, today: 0, yesterday: 0, week: 0, month: 0, year: 0, walletBalance: 0 });
  todayRevenue.forEach(r     => { row(r.currency).today         = r._sum.amount ?? 0; });
  yesterdayRevenue.forEach(r => { row(r.currency).yesterday     = r._sum.amount ?? 0; });
  weekRevenue.forEach(r      => { row(r.currency).week          = r._sum.amount ?? 0; });
  monthRevenue.forEach(r     => { row(r.currency).month         = r._sum.amount ?? 0; });
  yearRevenue.forEach(r      => { row(r.currency).year          = r._sum.amount ?? 0; });
  walletRows.forEach(r       => { row(r.currency).walletBalance = r._sum.balance ?? 0; });

  // A selected country always shows its own currency, even before its first payment.
  if (countryRow?.currencyCode) row(countryRow.currencyCode);

  const pct = (now, before) => {
    if (before > 0) return parseFloat((((now - before) / before) * 100).toFixed(1));
    return now > 0 ? 100 : null;                    // first revenue ever / nothing yet
  };
  const byCurrency = Object.values(byCur)
    .map((r) => ({ ...r, delta: pct(r.today, r.yesterday) }))
    .sort((a, b) => a.currency.localeCompare(b.currency));

  // Primary = the selected country's currency; otherwise Naira if present, else the first.
  const primaryCode = countryRow?.currencyCode
    || (byCur.NGN ? 'NGN' : (byCurrency[0]?.currency ?? 'NGN'));
  const primary = byCur[primaryCode] ?? { today: 0, yesterday: 0, week: 0, month: 0, year: 0, walletBalance: 0 };
  const revenueDelta = pct(primary.today, primary.yesterday);

  // ── Per-country money (only when the view spans several countries) ──────────
  // Currencies are shared (XOF is used by many markets), so this splits them back out.
  // Aggregated inside Postgres, so it stays fast however many payments exist.
  let byCountry = [];
  if (!countryCode) {
    const scoped = market && market.countryCode && Array.isArray(market.countryCode.in) ? market.countryCode.in : null;
    const payParams = [todayStart, monthStart, yearStart];
    const payScope  = scoped ? ' AND u."countryCode" = ANY($4::text[])' : '';
    if (scoped) payParams.push(scoped);
    const [payRows, walRows] = await Promise.all([
      prisma.$queryRawUnsafe(
        `SELECT u."countryCode" AS country, p.currency AS currency,
                COALESCE(SUM(p.amount) FILTER (WHERE p."createdAt" >= $1), 0) AS today,
                COALESCE(SUM(p.amount) FILTER (WHERE p."createdAt" >= $2), 0) AS month,
                COALESCE(SUM(p.amount), 0) AS year
           FROM "Payment" p JOIN "User" u ON u.id = p."userId"
          WHERE p.status = 'COMPLETED' AND p."createdAt" >= $3${payScope}
          GROUP BY u."countryCode", p.currency`, ...payParams),
      prisma.$queryRawUnsafe(
        `SELECT u."countryCode" AS country, w.currency AS currency, COALESCE(SUM(w.balance), 0) AS balance
           FROM "Wallet" w JOIN "User" u ON u.id = w."userId"
          WHERE u.role IN ('CUSTOMER','DRIVER','DELIVERY_PARTNER') AND u."isActive" = true${scoped ? ' AND u."countryCode" = ANY($1::text[])' : ''}
          GROUP BY u."countryCode", w.currency`, ...(scoped ? [scoped] : [])),
    ]);
    const acc = {};
    const slot = (cc, cur) => (acc[`${cc}|${cur}`] ??= { country: cc || '', currency: cur, today: 0, month: 0, year: 0, walletBalance: 0 });
    for (const r of payRows || []) Object.assign(slot(r.country, r.currency), { today: Number(r.today), month: Number(r.month), year: Number(r.year) });
    for (const r of walRows || []) slot(r.country, r.currency).walletBalance = Number(r.balance);
    const codes = [...new Set(Object.values(acc).map(r => r.country).filter(Boolean))];
    const names = codes.length
      ? await prisma.country.findMany({ where: { code: { in: codes } }, select: { code: true, name: true } })
      : [];
    const nameOf = Object.fromEntries((names || []).map(c => [c.code, c.name]));
    byCountry = Object.values(acc)
      .map(r => ({ ...r, name: nameOf[r.country] || r.country || 'Unassigned' }))
      .sort((x, y) => (y.year - x.year) || (y.walletBalance - x.walletBalance));
  }

  // ── User delta (today vs yesterday signups) ──────────────────────────────────
  let userDelta = null;
  if (newUsersYesterday > 0) {
    userDelta = parseFloat((((newUsersToday - newUsersYesterday) / newUsersYesterday) * 100).toFixed(1));
  } else if (newUsersToday > 0) {
    userDelta = 100;
  }

  res.status(200).json({
    success: true,
    data: {
      country:    countryCode,
      users:      { total: totalUsers, drivers: totalDrivers, partners: totalPartners, newToday: newUsersToday },
      rides:      { total: totalRides, active: activeRides },
      deliveries: { total: totalDeliveries, active: activeDeliveries },
      revenue: {
        today:         primary.today,
        yesterday:     primary.yesterday,
        month:         primary.month,
        week:          primary.week,
        year:          primary.year,
        currency:      primaryCode,
        revenueDelta,
        byCurrency,
        byCountry,
      },
      wallet:  { totalBalance: primary.walletBalance, currency: primaryCode, byCurrency: byCurrency.map(r => ({ currency: r.currency, balance: r.walletBalance })) },
      pending: { drivers: pendingDrivers, partners: pendingPartners },
      support: { openTickets },
      deltas:  { revenue: revenueDelta, users: userDelta },
      suspended: {
        driversCount:  suspendedDriversCount,
        partnersCount: suspendedPartnersCount,
        driversList:   suspendedDriversList,
        partnersList:  suspendedPartnersList,
      },
    },
  });
};

// ─────────────────────────────────────────────
// USER MANAGEMENT
// ─────────────────────────────────────────────

exports.getUsers = async (req, res) => {
  const { page = 1, limit = 20, role, search, isActive, country } = req.query;
  const skip = (page - 1) * limit;
  const where = { ...(marketWhere(req.user, country) || {}) };
  if (role) where.role = role;
  if (isActive !== undefined) where.isActive = isActive === 'true';
  if (search) {
    where.OR = [
      { firstName: { contains: search, mode: 'insensitive' } },
      { lastName:  { contains: search, mode: 'insensitive' } },
      { email:     { contains: search, mode: 'insensitive' } },
      { phone:     { contains: search, mode: 'insensitive' } },
    ];
  }
  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true, email: true, phone: true, firstName: true, lastName: true,
        role: true, isActive: true, isSuspended: true, isVerified: true, createdAt: true,
        adminDepartment: true, supportCountries: true, supportLanguages: true,
        wallet: { select: { balance: true, currency: true } },
      },
      skip: parseInt(skip), take: parseInt(limit), orderBy: { createdAt: 'desc' },
    }),
    prisma.user.count({ where }),
  ]);
  res.status(200).json({ success: true, data: { users, pagination: { total, page: parseInt(page), pages: Math.ceil(total / limit) } } });
};

exports.getUserById = async (req, res) => {
  const { id } = req.params;
  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true, email: true, phone: true, firstName: true, lastName: true,
      role: true, profileImage: true, isActive: true, isSuspended: true,
      isVerified: true, suspendedAt: true, suspensionReason: true, createdAt: true,
      driverProfile: true, deliveryProfile: true,
      wallet: { select: { balance: true, currency: true } },
      _count: { select: { customerRides: true, driverRides: true, customerDeliveries: true, partnerDeliveries: true, payments: true } },
    },
  });
  if (!user) throw new AppError('User not found', 404);
  res.status(200).json({ success: true, data: { user: require('../lib/redactProfile').redactUserForRole(user, req.user.role) } });
};

exports.suspendUser = async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  if (id === req.user.id)
    throw new AppError('You cannot suspend your own account.', 400);

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) throw new AppError('User not found.', 404);

  if (target.role === 'SUPER_ADMIN')
    throw new AppError('Super admin accounts cannot be suspended.', 403);

  if (target.role === 'ADMIN' && req.user.role !== 'SUPER_ADMIN' && !staffInsideMarkets(req.user, target))
    throw new AppError('Only a Super Admin, or the admin of that country, can suspend an Admin account.', 403);

  const user = await prisma.user.update({
    where: { id },
    data: {
      isActive:         false,
      isSuspended:      true,
      suspendedAt:      new Date(),
      suspendedBy:      req.user.id,
      suspensionReason: reason || 'Suspended by admin',
    },
  });

  await notificationService.notify({
    userId:  id,
    title:   'Account Suspended',
    message: `Your account has been suspended. Reason: ${reason || 'Policy violation'}. Contact support to appeal.`,
    type:    notificationService.TYPES.ACCOUNT_SUSPENDED,
    data:    { reason, suspendedBy: req.user.id },
  });

  if (target.email) {
    await safeSendEmail(
      () => emailService.sendAccountSuspendedEmail(target.email, target.firstName, reason || 'Policy violation'),
      'Account suspension'
    );
  }

  await logActivity({
    userId:     req.user.id,
    action:     'user_suspended',
    entityType: 'User',
    entityId:   id,
    details:    { reason },
    req,
  });

  res.status(200).json({ success: true, message: 'User suspended', data: { user } });
};

exports.activateUser = async (req, res) => {
  const { id } = req.params;
  const user = await prisma.user.update({
    where: { id },
    data: { isActive: true, isSuspended: false, suspendedAt: null, suspendedBy: null, suspensionReason: null },
  });
  await notificationService.notify({ userId: id, title: 'Account Activated ✅', message: 'Your account has been reactivated. Welcome back!', type: notificationService.TYPES.ACCOUNT_ACTIVATED, data: {} });

  if (user.email) {
    await safeSendEmail(
      () => emailService.sendAccountReactivatedEmail(user.email, user.firstName),
      'Account reactivation'
    );
  }

  await logActivity({ userId: req.user.id, action: 'user_activated', entityType: 'User', entityId: id, details: {}, req });
  res.status(200).json({ success: true, message: 'User activated', data: { user } });
};

// ─── DELETE USER (SUPER_ADMIN only — soft delete) ────────────────────────────

exports.deleteUser = async (req, res) => {
  const { id } = req.params;

  if (id === req.user.id)
    throw new AppError('You cannot delete your own account', 400);

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new AppError('User not found', 404);

  if (user.role === 'SUPER_ADMIN')
    throw new AppError('Super admin accounts cannot be deleted', 403);
  if (['ADMIN', 'SUPPORT', 'MODERATOR'].includes(user.role) && !staffInsideMarkets(req.user, user))
    throw new AppError('You can only delete staff accounts that belong to your own countries.', 403);

  // Capture original PII before anonymizing — the email service needs it,
  // and it won't exist on the row anymore after this update.
  const originalEmail = user.email;
  const originalFirstName = user.firstName;

  const anonymisedEmail = `deleted_${id}@runserv.internal`;
  const anonymisedPhone = `+000${id.replace(/-/g, '').slice(0, 12)}`;

  const deleted = await prisma.user.update({
    where: { id },
    data: {
      isActive:    false,
      isSuspended: true,
      email:       anonymisedEmail,
      phone:       anonymisedPhone,
      firstName:   'Deleted',
      lastName:    'User',
      profileImage: null,
      suspensionReason: 'Account deleted by admin',
    },
    select: { id: true, role: true, createdAt: true },
  });

  if (originalEmail) {
    await safeSendEmail(
      () => emailService.sendAccountDeletedEmail(originalEmail, originalFirstName),
      'Account deletion'
    );
  }

  await logActivity({
    userId: req.user.id,
    action: 'user_deleted',
    entityType: 'User',
    entityId: id,
    details: { originalRole: user.role, originalEmail: user.email },
    req,
  });

  res.status(200).json({
    success: true,
    message: 'User account deleted and PII anonymised',
    data: { user: deleted },
  });
};

// ─────────────────────────────────────────────
// INCOMPLETE APPLICATIONS
// Users who selected DRIVER / DELIVERY_PARTNER at signup but never
// finished their application — either no profile row was ever created
// (they dropped off right after choosing a role), or a profile exists but
// no documents were ever uploaded and it's still neither approved nor
// rejected. Purely informational — for admins to follow up / nudge users
// who stalled mid-onboarding, not for approval decisions.
// ─────────────────────────────────────────────
exports.getIncompleteApplications = async (req, res) => {
  const { role, adminDepartment } = req.user;

  // Scope by department the same way requireScope('RIDES','DELIVERIES') let
  // this route through: a RIDES-only admin should only see stalled DRIVER
  // applications, a DELIVERIES-only admin only DELIVERY_PARTNER, and
  // SUPER_ADMIN / general ADMIN (no department) sees both.
  let roles = ['DRIVER', 'DELIVERY_PARTNER'];
  if (role === 'ADMIN' && adminDepartment === 'RIDES') roles = ['DRIVER'];
  if (role === 'ADMIN' && adminDepartment === 'DELIVERIES') roles = ['DELIVERY_PARTNER'];

  const users = await prisma.user.findMany({
    where: {
      role: { in: roles },
      isDeleted: false,
      ...(marketWhere(req.user, req.query.country) || {}),
    },
    select: {
      id: true, firstName: true, lastName: true, email: true, phone: true,
      role: true, createdAt: true, profileImage: true,
      driverProfile:   { select: { isApproved: true, isRejected: true, documentsUploadedAt: true, vehicleType: true } },
      deliveryProfile: { select: { isApproved: true, isRejected: true, documentsUploadedAt: true, vehicleType: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const incomplete = users
    .map(u => {
      const profile = u.role === 'DRIVER' ? u.driverProfile : u.deliveryProfile;
      let stage;
      if (!profile) {
        stage = 'NOT_STARTED';           // picked a role, never even started the profile form
      } else if (profile.isApproved || profile.isRejected) {
        return null;                     // already resolved one way or another — not "incomplete"
      } else if (!profile.documentsUploadedAt) {
        stage = 'PROFILE_ONLY';          // profile form filled, no documents uploaded
      } else {
        return null;                     // docs uploaded, just waiting on review — that's "pending", not "incomplete"
      }
      const daysSinceSignup = Math.floor((Date.now() - new Date(u.createdAt).getTime()) / 86400000);
      return {
        id: u.id, firstName: u.firstName, lastName: u.lastName,
        email: u.email, phone: u.phone, role: u.role,
        profileImage: u.profileImage, createdAt: u.createdAt,
        daysSinceSignup, stage,
      };
    })
    .filter(Boolean);

  res.status(200).json({
    success: true,
    data: {
      total: incomplete.length,
      applications: incomplete,
    },
  });
};

// ─────────────────────────────────────────────
// DRIVER MANAGEMENT
// ─────────────────────────────────────────────

exports.getPendingDrivers = async (req, res) => {
  const userWhere = marketWhere(req.user, req.query.country);
  const drivers = await prisma.driverProfile.findMany({
    where: {
      isApproved: false,
      isRejected: false,
      ...(userWhere ? { user: userWhere } : {}),
    },
    include: {
      user: {
        select: {
          id: true, firstName: true, lastName: true,
          email: true, phone: true, countryCode: true,
          profileImage: true, createdAt: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  // Pending count per country (within the staff member's own markets) for the filter chips.
  const scope = scopeOnlyWhere(req.user);
  const pendingRows = await prisma.driverProfile.findMany({
    where: { isApproved: false, isRejected: false, ...(scope ? { user: scope } : {}) },
    select: { user: { select: { countryCode: true } } },
  });
  const byCountry = tallyByCountry(pendingRows);

  // Attach a derived `documentStatus` to each record so the admin dashboard
  // can surface "Has all docs", "Partial docs", or "No docs" without extra queries.
  const enriched = drivers.map(d => ({
    ...d,
    documentStatus: deriveDocumentStatus(d),
  }));

  res.status(200).json({ success: true, data: { drivers: enriched, byCountry } });
};

// Helper — does NOT block approval, it's purely informational for the admin UI.
function getRequiredDriverDocs(vehicleType) {
  const base = [
    'licenseImageUrl', 'vehicleRegUrl', 'insuranceUrl',
    'roadWorthinessUrl', 'vehiclePhotoExteriorUrl', 'vehiclePhotoInteriorUrl',
    'applicantPhotoUrl', 'govtIdUrl', 'proofOfAddressUrl',
  ];
  const byType = {
    CAR:        [...base, 'vehicleInspectionUrl', 'hackneyCertUrl'],
    VAN:        [...base, 'vehicleInspectionUrl', 'hackneyCertUrl'],
    MOTORCYCLE: [...base, 'riderCardUrl', 'helmetPhotoUrl', 'guarantorLetterUrl', 'guarantorIdUrl'],
    BIKE:       [...base, 'dispatchPermitUrl', 'guarantorLetterUrl', 'guarantorIdUrl'],
    TRICYCLE:   [...base, 'operatorPermitUrl', 'guarantorLetterUrl', 'guarantorIdUrl'],
  };
  return byType[vehicleType?.toUpperCase()] ?? base;
}

function deriveDocumentStatus(profile) {
  const required = getRequiredDriverDocs(profile.vehicleType);
  const uploaded = required.filter(f => profile[f]).length;
  if (uploaded === required.length && required.length > 0) return 'COMPLETE';
  if (uploaded > 0) return 'PARTIAL';
  return 'NONE';
}

const licence = require('../services/driverLicence.service');

/**
 * M13 — PUT /api/admin/drivers/:id/licence   { action: 'VERIFY'|'REJECT', licenseClass?, licenseExpiresAt?, reason? }
 * A reviewer records the class and expiry they SAW on the licence and verifies it (or rejects it with a reason). Audited.
 */
exports.reviewDriverLicence = async (req, res) => {
  const { action, reason } = req.body;
  const p = await prisma.driverProfile.findUnique({ where: { id: req.params.id }, include: { user: { select: { countryCode: true } } } });
  if (!p) throw new AppError('Driver profile not found.', 404);
  if (!canActInMarket(req.user, p.user?.countryCode)) throw new AppError('This driver is outside your assigned countries.', 403);
  let data;
  if (action === 'REJECT') {
    if (!reason || !String(reason).trim()) throw new AppError('A rejection reason is required.', 400);
    data = { licenseVerificationStatus: 'REJECTED', licenseVerifiedAt: null, licenseVerifiedById: null, licenseRejectedReason: String(reason).trim().slice(0, 500) };
  } else {
    const cls = licence.normaliseClass(req.body.licenseClass ?? p.licenseClass);
    const exp = req.body.licenseExpiresAt ?? p.licenseExpiresAt;
    if (!p.licenseNumber || !p.licenseImageUrl) throw new AppError('The licence number and image must be on file before verifying.', 400);
    if (!cls) throw new AppError('Licence class is required.', 400);
    const expD = exp ? new Date(exp) : null;
    if (!expD || !Number.isFinite(expD.getTime())) throw new AppError('A valid licence expiry date is required.', 400);
    if (licence.licenceExpired(expD)) throw new AppError('This licence has already expired and cannot be verified.', 400);
    data = { licenseClass: cls, licenseExpiresAt: expD, licenseVerificationStatus: 'VERIFIED', licenseVerifiedAt: new Date(), licenseVerifiedById: req.user.id, licenseRejectedReason: null };
  }
  const row = await prisma.driverProfile.update({ where: { id: p.id }, data, select: { id: true, licenseClass: true, licenseExpiresAt: true, licenseVerificationStatus: true, licenseVerifiedAt: true, licenseRejectedReason: true } });
  await logActivity({ userId: req.user.id, action: action === 'REJECT' ? 'driver_licence_rejected' : 'driver_licence_verified', entityType: 'DriverProfile', entityId: p.id, details: { licenseClass: data.licenseClass ?? p.licenseClass, licenseExpiresAt: data.licenseExpiresAt ?? p.licenseExpiresAt, reason: reason ?? null }, req });
  res.status(200).json({ success: true, data: { licence: row } });
};

exports.approveDriver = async (req, res) => {
  const { id } = req.params;
  const { grantBonus = false, bonusAmount: bonusOverride, note = '' } = req.body;

  const driver = await prisma.driverProfile.findUnique({
    where:   { id },
    // NOTE: email is now selected so we can notify the driver directly.
    include: { user: { select: { id: true, firstName: true, lastName: true, email: true, countryCode: true } } },
  });
  if (!driver)            throw new AppError('Driver profile not found.', 404);
  if (!canActInMarket(req.user, driver.user?.countryCode)) throw new AppError('This driver is outside your assigned countries.', 403);
  if (driver.isApproved)  throw new AppError('Driver is already approved.', 400);
  // M13: no approval without a verified, unexpired licence of a permitted class (when enforcement is on).
  if (licence.licenceEnforced()) {
    const l = licence.checkLicence({ profile: driver });
    if (!l.ok) { const e = new AppError(`Cannot approve: ${l.failures.map((f) => f.message).join(' ')}`, 400); e.code = l.failures[0].code; throw e; }
  }

  const updatedDriver = await prisma.driverProfile.update({
    where: { id },
    data: {
      isApproved:     true,
      isRejected:     false,  // clear any prior rejection
      approvedAt:     new Date(),
      approvedBy:     req.user.id,
      rejectedAt:     null,
      rejectedBy:     null,
      rejectionReason: null,
    },
    include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
  });

  // Optional onboarding bonus (SUPER_ADMIN only)
  let bonusCredited = 0;
  const bonusAmount = grantBonus ? await bonusFor('driver', driver.user.countryCode, bonusOverride) : 0;
  const bonusWallet = grantBonus ? await prisma.wallet.findUnique({ where: { userId: driver.userId }, select: { currency: true } }) : null;
  const canGrantBonus = hasCountryAuthority(req.user) && grantBonus && bonusAmount > 0;
  if (canGrantBonus) {
    const wallet = await prisma.wallet.findUnique({ where: { userId: driver.userId } });
    if (wallet) {
      await prisma.$transaction([
        prisma.wallet.update({
          where: { id: wallet.id },
          data:  { balance: { increment: bonusAmount } },
        }),
        prisma.walletTransaction.create({
          data: {
            walletId:    wallet.id,
            type:        'CREDIT',
            amount:      bonusAmount,
            description: 'Onboarding bonus — for accepting rides only, non-withdrawable.',
            status:      'COMPLETED',
            reference:   `ONBOARDING-DRV-${driver.userId}-${Date.now()}`,
          },
        }),
      ]);
      bonusCredited = bonusAmount;
    }
  }

  const docStatus     = deriveDocumentStatus(driver);
  const docStatusNote = docStatus === 'NONE'
    ? ' Note: this driver has not yet uploaded their documents — please follow up if required.'
    : docStatus === 'PARTIAL'
    ? ' Note: this driver has uploaded some but not all documents.'
    : '';

  const bonusNote = bonusCredited > 0
    ? ` We've credited ${formatMoney(bonusCredited, bonusWallet?.currency, driver.user.countryCode)} to your wallet to get you started.`
    : '';

  // ── In-app notification ────────────────────────────────────────────────────
  await notificationService.notify({
    userId:  driver.userId,
    title:   'Application Approved! 🎉',
    message: `Welcome to the team, ${driver.user.firstName}! Your driver account is now active. Go online to start accepting rides.${bonusNote}${note ? ` Admin note: ${note}` : ''}`,
    type:    notificationService.TYPES.DRIVER_APPROVED,
    data:    { driverProfileId: id, bonusCredited, approvedBy: req.user.id },
  });

  // ── Email notification (non-fatal — approval already committed) ───────────
  if (driver.user.email) {
    await safeSendEmail(
      () => emailService.sendDriverApprovedEmail(driver.user.email, driver.user.firstName, {
        bonusAmount: bonusCredited,
        note,
      }),
      'Driver approval'
    );
  }

  await logActivity({
    userId:     req.user.id,
    action:     'driver_approved',
    entityType: 'DriverProfile',
    entityId:   id,
    details:    {
      driverUserId: driver.userId,
      bonusCredited,
      documentStatus: docStatus,
      approvedWithoutDocs: docStatus === 'NONE',
      note,
    },
    req,
  });

  res.status(200).json({
    success: true,
    message: `Driver approved.${bonusCredited ? ` ${formatMoney(bonusCredited, bonusWallet?.currency, driver.user.countryCode)} onboarding bonus credited.` : ''}${docStatusNote}`,
    data:    { driver: updatedDriver, bonusCredited, documentStatus: docStatus },
  });
};

exports.rejectDriver = async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  if (!reason || !reason.trim())
    throw new AppError('A rejection reason is required.', 400);

  const driver = await prisma.driverProfile.findUnique({
    where:   { id },
    // NOTE: email is now selected so we can notify the driver directly.
    include: { user: { select: { id: true, firstName: true, email: true, countryCode: true } } },
  });
  if (!driver) throw new AppError('Driver profile not found.', 404);
  if (!canActInMarket(req.user, driver.user?.countryCode)) throw new AppError('This driver is outside your assigned countries.', 403);

  await prisma.driverProfile.update({
    where: { id },
    data: {
      isApproved:      false,
      isRejected:      true,
      rejectedAt:      new Date(),
      rejectedBy:      req.user.id,
      rejectionReason: reason.trim(),
    },
  });

  await notificationService.notify({
    userId:  driver.userId,
    title:   'Application Not Approved',
    message: `Unfortunately your driver application was not approved at this time. Reason: ${reason}. Please contact support if you have questions or wish to reapply.`,
    type:    notificationService.TYPES.DRIVER_REJECTED,
    data:    { reason, rejectedBy: req.user.id },
  });

  if (driver.user.email) {
    await safeSendEmail(
      () => emailService.sendDriverRejectedEmail(driver.user.email, driver.user.firstName, reason.trim()),
      'Driver rejection'
    );
  }

  await logActivity({
    userId:     req.user.id,
    action:     'driver_rejected',
    entityType: 'DriverProfile',
    entityId:   id,
    details:    { reason, driverUserId: driver.userId },
    req,
  });

  res.status(200).json({
    success: true,
    message: 'Driver application rejected. The driver has been notified.',
    data:    { driverProfileId: id, reason },
  });
};

exports.getDrivers = async (req, res) => {
  const { page = 1, limit = 20, search, isApproved, isRejected, vehicleType, country } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const where = {};
  if (isApproved !== undefined) where.isApproved = isApproved === 'true';
  if (isRejected !== undefined) where.isRejected = isRejected === 'true';
  if (vehicleType) where.vehicleType = vehicleType.toUpperCase();
  const userWhere = { ...(marketWhere(req.user, country) || {}) };
  if (search) {
    userWhere.OR = [
      { firstName: { contains: search, mode: 'insensitive' } },
      { lastName:  { contains: search, mode: 'insensitive' } },
      { email:     { contains: search, mode: 'insensitive' } },
      { phone:     { contains: search, mode: 'insensitive' } },
    ];
  }
  if (Object.keys(userWhere).length) where.user = userWhere;

  const [drivers, total] = await Promise.all([
    prisma.driverProfile.findMany({
      where,
      include: {
        user: {
          select: {
            id: true, firstName: true, lastName: true,
            email: true, phone: true, createdAt: true, countryCode: true,
            isActive: true, isSuspended: true, isVerified: true,
            wallet: { select: { currency: true } },
          },
        },
      },
      skip,
      take:    parseInt(limit),
      orderBy: { createdAt: 'desc' },
    }),
    prisma.driverProfile.count({ where }),
  ]);

  res.status(200).json({
    success: true,
    data: {
      drivers: drivers.map(d => ({ ...d, documentStatus: deriveDocumentStatus(d) })),
      pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) },
    },
  });
};

exports.getDriverById = async (req, res) => {
  const { id } = req.params;
 
  const driver = await prisma.driverProfile.findUnique({
    where: { id },
    include: {
      user: {
        select: {
          id: true, firstName: true, lastName: true, email: true, phone: true,
          profileImage: true, isActive: true, isSuspended: true, createdAt: true,
          wallet: { select: { balance: true, currency: true } },
          _count: { select: { driverRides: true } },
        },
      },
    },
  });
 
  if (!driver) throw new AppError('Driver not found', 404);
 
  // Recent rides
  const recentRides = await prisma.ride.findMany({
    where: { driverId: driver.userId },
    include: { customer: { select: { firstName: true, lastName: true } }, payment: { select: { amount: true, method: true, driverEarnings: true } } },
    orderBy: { requestedAt: 'desc' },
    take: 10,
  });
 
  res.status(200).json({
    success: true,
    data: {
      driver: { ...driver, documentStatus: deriveDocumentStatus(driver) },
      recentRides,
    },
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// PARTNER MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

// Helper — purely informational for the admin UI, does NOT block approval.
function getRequiredPartnerDocs(vehicleType) {
  const base = [
    'idImageUrl', 'vehicleImageUrl', 'applicantPhotoUrl',
    'govtIdUrl', 'proofOfAddressUrl', 'insuranceUrl',
    'roadWorthinessUrl', 'vehiclePhotoExteriorUrl', 'vehiclePhotoInteriorUrl',
  ];
  const byType = {
    CAR:        base,
    VAN:        base,
    MOTORCYCLE: [...base, 'riderCardUrl', 'helmetPhotoUrl', 'guarantorLetterUrl', 'guarantorIdUrl'],
    BIKE:       [...base, 'dispatchPermitUrl', 'guarantorLetterUrl', 'guarantorIdUrl'],
    TRICYCLE:   [...base, 'operatorPermitUrl', 'guarantorLetterUrl', 'guarantorIdUrl'],
  };
  return byType[vehicleType?.toUpperCase()] ?? base;
}

function derivePartnerDocumentStatus(profile) {
  const required = getRequiredPartnerDocs(profile.vehicleType);
  const uploaded = required.filter(f => profile[f]).length;
  if (uploaded === required.length && required.length > 0) return 'COMPLETE';
  if (uploaded > 0) return 'PARTIAL';
  return 'NONE';
}

exports.getPendingPartners = async (req, res) => {
  const userWhere = marketWhere(req.user, req.query.country);
  const partners = await prisma.deliveryPartnerProfile.findMany({
    where: {
      isApproved: false,
      isRejected: false,           // ← only truly pending, not rejected
      ...(userWhere ? { user: userWhere } : {}),
    },
    include: {
      user: {
        select: {
          id: true, firstName: true, lastName: true,
          email: true, phone: true, countryCode: true,
          profileImage: true, createdAt: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  const scope = scopeOnlyWhere(req.user);
  const pendingRows = await prisma.deliveryPartnerProfile.findMany({
    where: { isApproved: false, isRejected: false, ...(scope ? { user: scope } : {}) },
    select: { user: { select: { countryCode: true } } },
  });
  const byCountry = tallyByCountry(pendingRows);

  const enriched = partners.map(p => ({
    ...p,
    documentStatus: derivePartnerDocumentStatus(p),
  }));

  res.status(200).json({ success: true, data: { partners: enriched, byCountry } });
};

exports.approvePartner = async (req, res) => {
  const { id } = req.params;
  const { grantBonus = false, bonusAmount: bonusOverride, note = '' } = req.body;

  const partner = await prisma.deliveryPartnerProfile.findUnique({
    where:   { id },
    // NOTE: email is now selected so we can notify the partner directly.
    include: { user: { select: { id: true, firstName: true, lastName: true, email: true, countryCode: true } } },
  });
  if (!partner)           throw new AppError('Partner profile not found.', 404);
  if (!canActInMarket(req.user, partner.user?.countryCode)) throw new AppError('This partner is outside your assigned countries.', 403);
  if (partner.isApproved) throw new AppError('Partner is already approved.', 400);

  const updatedPartner = await prisma.deliveryPartnerProfile.update({
    where: { id },
    data: {
      isApproved:      true,
      isRejected:      false,     // clear any prior rejection
      approvedAt:      new Date(),
      approvedBy:      req.user.id,
      rejectedAt:      null,
      rejectedBy:      null,
      rejectionReason: null,
    },
    include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
  });

  // Optional onboarding bonus (SUPER_ADMIN only)
  let bonusCredited = 0;
  const bonusAmount = grantBonus ? await bonusFor('partner', partner.user.countryCode, bonusOverride) : 0;
  const bonusWallet = grantBonus ? await prisma.wallet.findUnique({ where: { userId: partner.userId }, select: { currency: true } }) : null;
  const canGrantBonus = hasCountryAuthority(req.user) && grantBonus && bonusAmount > 0;
  if (canGrantBonus) {
    const wallet = await prisma.wallet.findUnique({ where: { userId: partner.userId } });
    if (wallet) {
      await prisma.$transaction([
        prisma.wallet.update({
          where: { id: wallet.id },
          data:  { balance: { increment: bonusAmount } },
        }),
        prisma.walletTransaction.create({
          data: {
            walletId:    wallet.id,
            type:        'CREDIT',
            amount:      bonusAmount,
            description: 'Onboarding bonus — for accepting deliveries only, non-withdrawable.',
            status:      'COMPLETED',
            reference:   `ONBOARDING-PTR-${partner.userId}-${Date.now()}`,
          },
        }),
      ]);
      bonusCredited = bonusAmount;
    }
  }

  const docStatus     = derivePartnerDocumentStatus(partner);
  const docStatusNote = docStatus === 'NONE'
    ? ' Note: this partner has not yet uploaded their documents — please follow up if required.'
    : docStatus === 'PARTIAL'
    ? ' Note: this partner has uploaded some but not all documents.'
    : '';

  const bonusNote = bonusCredited > 0
    ? ` We've credited ${formatMoney(bonusCredited, bonusWallet?.currency, partner.user.countryCode)} to your wallet to get you started.`
    : '';

  await notificationService.notify({
    userId:  partner.userId,
    title:   'Application Approved! 🎉',
    message: `Welcome to the team, ${partner.user.firstName}! Your courier account is now active. Go online to start accepting deliveries.${bonusNote}${note ? ` Admin note: ${note}` : ''}`,
    type:    notificationService.TYPES.PARTNER_APPROVED,
    data:    { partnerProfileId: id, bonusCredited, approvedBy: req.user.id },
  });

  if (partner.user.email) {
    await safeSendEmail(
      () => emailService.sendPartnerApprovedEmail(partner.user.email, partner.user.firstName, {
        bonusAmount: bonusCredited,
        note,
      }),
      'Partner approval'
    );
  }

  await logActivity({
    userId:     req.user.id,
    action:     'partner_approved',
    entityType: 'DeliveryPartnerProfile',
    entityId:   id,
    details:    {
      partnerUserId: partner.userId,
      bonusCredited,
      documentStatus: docStatus,
      approvedWithoutDocs: docStatus === 'NONE',
      note,
    },
    req,
  });

  res.status(200).json({
    success: true,
    message: `Partner approved.${bonusCredited ? ` ${formatMoney(bonusCredited, bonusWallet?.currency, partner.user.countryCode)} onboarding bonus credited.` : ''}${docStatusNote}`,
    data:    { partner: updatedPartner, bonusCredited, documentStatus: docStatus },
  });
};

exports.rejectPartner = async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  if (!reason || !reason.trim())
    throw new AppError('A rejection reason is required.', 400);

  const partner = await prisma.deliveryPartnerProfile.findUnique({
    where:   { id },
    // NOTE: email is now selected so we can notify the partner directly.
    include: { user: { select: { id: true, firstName: true, email: true, countryCode: true } } },
  });
  if (!partner) throw new AppError('Partner profile not found.', 404);
  if (!canActInMarket(req.user, partner.user?.countryCode)) throw new AppError('This partner is outside your assigned countries.', 403);

  // ← UPDATE instead of DELETE — partner can see rejection reason and reapply
  await prisma.deliveryPartnerProfile.update({
    where: { id },
    data: {
      isApproved:      false,
      isRejected:      true,
      rejectedAt:      new Date(),
      rejectedBy:      req.user.id,
      rejectionReason: reason.trim(),
    },
  });

  await notificationService.notify({
    userId:  partner.userId,
    title:   'Application Not Approved',
    message: `Unfortunately your courier application was not approved at this time. Reason: ${reason}. Please contact support if you have questions or wish to reapply.`,
    type:    notificationService.TYPES.PARTNER_REJECTED,
    data:    { reason, rejectedBy: req.user.id },
  });

  if (partner.user.email) {
    await safeSendEmail(
      () => emailService.sendPartnerRejectedEmail(partner.user.email, partner.user.firstName, reason.trim()),
      'Partner rejection'
    );
  }

  await logActivity({
    userId:     req.user.id,
    action:     'partner_rejected',
    entityType: 'DeliveryPartnerProfile',
    entityId:   id,
    details:    { reason, partnerUserId: partner.userId },
    req,
  });

  res.status(200).json({
    success: true,
    message: 'Partner application rejected. The partner has been notified.',
    data:    { partnerProfileId: id, reason },
  });
};

exports.getPartners = async (req, res) => {
  const { page = 1, limit = 20, search, isApproved, isRejected, vehicleType, country } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const where = {};
  if (isApproved !== undefined) where.isApproved = isApproved === 'true';
  if (isRejected !== undefined) where.isRejected = isRejected === 'true';  // ← NEW filter
  if (vehicleType) where.vehicleType = vehicleType.toUpperCase();
  const userWhere = { ...(marketWhere(req.user, country) || {}) };
  if (search) {
    userWhere.OR = [
      { firstName: { contains: search, mode: 'insensitive' } },
      { lastName:  { contains: search, mode: 'insensitive' } },
      { email:     { contains: search, mode: 'insensitive' } },
      { phone:     { contains: search, mode: 'insensitive' } },
    ];
  }
  if (Object.keys(userWhere).length) where.user = userWhere;

  const [partners, total] = await Promise.all([
    prisma.deliveryPartnerProfile.findMany({
      where,
      include: {
        user: {
          select: {
            id: true, firstName: true, lastName: true,
            email: true, phone: true, createdAt: true, countryCode: true,
            isActive: true, isSuspended: true, isVerified: true,
            wallet: { select: { currency: true } },
          },
        },
      },
      skip,
      take:    parseInt(limit),
      orderBy: { createdAt: 'desc' },
    }),
    prisma.deliveryPartnerProfile.count({ where }),
  ]);

  res.status(200).json({
    success: true,
    data: {
      partners: partners.map(p => ({ ...p, documentStatus: derivePartnerDocumentStatus(p) })),
      pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) },
    },
  });
};

exports.getPartnerById = async (req, res) => {
  const { id } = req.params;

  const partner = await prisma.deliveryPartnerProfile.findUnique({
    where: { id },
    include: {
      user: {
        select: {
          id: true, firstName: true, lastName: true, email: true, phone: true,
          profileImage: true, isActive: true, isSuspended: true, isVerified: true,
          suspensionReason: true, createdAt: true,
          wallet: { select: { balance: true, currency: true } },
          _count: { select: { partnerDeliveries: true } },
        },
      },
    },
  });

  if (!partner) throw new AppError('Delivery partner not found', 404);

  const recentDeliveries = await prisma.delivery.findMany({
    where:   { partnerId: partner.userId },
    include: {
      customer: { select: { firstName: true, lastName: true } },
      payment:  { select: { amount: true, method: true, driverEarnings: true } },
    },
    orderBy: { requestedAt: 'desc' },
    take:    10,
  });

  res.status(200).json({
    success: true,
    data: {
      partner: { ...partner, documentStatus: derivePartnerDocumentStatus(partner) },
      recentDeliveries,
    },
  });
};

// ─────────────────────────────────────────────
// RIDE & DELIVERY MANAGEMENT
// ─────────────────────────────────────────────

exports.getRides = async (req, res) => {
  const { page = 1, limit = 20, status, driverId, customerId, startDate, endDate, country } = req.query;
  const skip = (page - 1) * limit;
  const where = {};
  const market = marketWhere(req.user, country);
  if (market) where.customer = market;
  if (status) where.status = status;
  if (driverId) where.driverId = driverId;
  if (customerId) where.customerId = customerId;
  if (startDate || endDate) {
    where.requestedAt = {};
    if (startDate) where.requestedAt.gte = new Date(startDate);
    if (endDate)   where.requestedAt.lte = new Date(endDate);
  }
  const [rides, total] = await Promise.all([
    prisma.ride.findMany({ where, include: { customer: { select: { firstName: true, lastName: true, email: true, countryCode: true } }, driver: { select: { firstName: true, lastName: true, email: true } }, payment: true }, skip: parseInt(skip), take: parseInt(limit), orderBy: { requestedAt: 'desc' } }),
    prisma.ride.count({ where }),
  ]);
  res.status(200).json({ success: true, data: { rides, pagination: { total, page: parseInt(page), pages: Math.ceil(total / limit) } } });
};

exports.getDeliveries = async (req, res) => {
  const { page = 1, limit = 20, status, partnerId, customerId, country } = req.query;
  const skip = (page - 1) * limit;
  const where = {};
  const market = marketWhere(req.user, country);
  if (market) where.customer = market;
  if (status) where.status = status;
  if (partnerId) where.partnerId = partnerId;
  if (customerId) where.customerId = customerId;
  const [deliveries, total] = await Promise.all([
    prisma.delivery.findMany({ where, include: { customer: { select: { firstName: true, lastName: true, email: true, countryCode: true } }, partner: { select: { firstName: true, lastName: true, email: true } }, payment: true }, skip: parseInt(skip), take: parseInt(limit), orderBy: { requestedAt: 'desc' } }),
    prisma.delivery.count({ where }),
  ]);
  res.status(200).json({ success: true, data: { deliveries, pagination: { total, page: parseInt(page), pages: Math.ceil(total / limit) } } });
};

// ─────────────────────────────────────────────
// PAYMENT MANAGEMENT
// ─────────────────────────────────────────────

exports.getPayments = async (req, res) => {
  const {
    page   = 1,
    limit  = 25,
    status,
    method,
    provider,
    currency,
    search,
    hasRide,
    hasDelivery,
    country,
  } = req.query;
 
  const skip = (parseInt(page) - 1) * parseInt(limit);
 
  const where = {};
  const payMarket = marketWhere(req.user, country);
  if (payMarket) where.AND = [{ user: payMarket }];
  if (status)            where.status  = status;
  if (method)            where.method  = method;
  if (provider)          where.provider = String(provider).toLowerCase();
  if (currency)          where.currency = String(currency).toUpperCase();
  if (hasRide === 'true')     where.rideId     = { not: null };
  if (hasDelivery === 'true') where.deliveryId = { not: null };
  if (search) {
    where.OR = [
      { transactionId: { contains: search, mode: 'insensitive' } },
      { providerRef:   { contains: search, mode: 'insensitive' } },
      { user: { firstName: { contains: search, mode: 'insensitive' } } },
      { user: { lastName:  { contains: search, mode: 'insensitive' } } },
      { user: { email:     { contains: search, mode: 'insensitive' } } },
      { user: { phone:     { contains: search } } },
    ];
  }
 
  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
        // Join CommissionLedger for platformFee / earnerAmount
        commissionLedger: { select: { commissionAmount: true, earnerAmount: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit),
    }),
    prisma.payment.count({ where }),
  ]);
 
  // Flatten commission fields into payment object
  const enriched = payments.map(p => ({
    ...p,
    platformFee:    p.commissionLedger?.commissionAmount ?? p.platformFee   ?? undefined,
    driverEarnings: p.commissionLedger?.earnerAmount     ?? p.driverEarnings ?? undefined,
    commissionLedger: undefined, // don't double-send
  }));
 
  res.status(200).json({
    success: true,
    data: {
      payments: enriched,
      pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) },
    },
  });
};

exports.getPaymentById = async (req, res) => {
  const { id } = req.params;
  const payment = await prisma.payment.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
      commissionLedger: { select: { commissionAmount: true, earnerAmount: true } },
    },
  });
  if (!payment) throw new AppError('Payment not found', 404);
  res.status(200).json({ success: true, data: { payment } });
};

// ─────────────────────────────────────────────
// ADMIN — REFUNDS
// ─────────────────────────────────────────────

exports.getRefunds = async (req, res) => {
  const { page = 1, limit = 25, method, search, currency, country } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const where = { status: 'REFUNDED' };
  const refundMarket = marketWhere(req.user, country);
  if (refundMarket) where.AND = [{ user: refundMarket }];
  if (method) where.method = method;
  if (currency) where.currency = String(currency).toUpperCase();
  if (search) {
    where.OR = [
      { transactionId: { contains: search, mode: 'insensitive' } },
      { user: { firstName: { contains: search, mode: 'insensitive' } } },
      { user: { lastName:  { contains: search, mode: 'insensitive' } } },
      { user: { email:     { contains: search, mode: 'insensitive' } } },
    ];
  }

  const [refunds, total, totalsByCurrency] = await Promise.all([
    prisma.payment.findMany({
      where,
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
      },
      orderBy: { refundedAt: 'desc' },
      skip,
      take: parseInt(limit),
    }),
    prisma.payment.count({ where }),
    // Refund totals are per currency — a single sum across NGN/XOF/GHS is meaningless.
    prisma.payment.groupBy({ by: ['currency'], where, _sum: { refundAmount: true } }),
  ]);

  res.status(200).json({
    success: true,
    data: {
      refunds,
      totalsByCurrency: totalsByCurrency.map(t => ({ currency: t.currency, total: t._sum.refundAmount ?? 0 })),
      pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) },
    },
  });
};

/**
 * Admin-initiated refund — bypasses the ownership check that guards the
 * user-facing paymentController.requestRefund. Only reachable by ADMIN/SUPER_ADMIN
 * via the route middleware.
 */
exports.adminIssueRefund = async (req, res) => {
  const { id } = req.params;
  const { amount, reason = '', manuallySettled = false } = req.body;

  const payment = await prisma.payment.findUnique({
    where: { id },
    include: { user: { select: { id: true, firstName: true, email: true, countryCode: true } } },
  });
  if (!payment) throw new AppError('Payment not found', 404);
  if (payment.status !== 'COMPLETED') throw new AppError('Only completed payments can be refunded', 400);
  if (payment.method === 'CASH') throw new AppError('Cash payments cannot be refunded automatically. Contact the customer directly.', 400);

  const refundAmount = amount === undefined || amount === null || amount === '' ? Number(payment.amount) : Number(amount);
  if (!Number.isFinite(refundAmount) || refundAmount <= 0) throw new AppError('Enter a valid refund amount.', 400);
  if (refundAmount > payment.amount) throw new AppError('Refund amount cannot exceed the original payment amount', 400);
  if (isWholeUnitCurrency(payment.currency) && !Number.isInteger(refundAmount)) {
    throw new AppError(`${payment.currency} has no decimals — enter a whole amount.`, 400);
  }

  // The provider that actually took the money. Rows created before the
  // `provider` column existed were all Paystack card payments.
  const refundProvider = payment.method === 'WALLET'
    ? null
    : (payment.provider ?? (payment.method === 'MOBILE_MONEY' ? 'orange' : 'paystack'));

  // Take the payment out of COMPLETED first, and only carry on if WE did it. Two staff clicking Refund together (or a
  // double click) both read COMPLETED; before this, both would pay the customer back.
  const claimed = await claim(prisma.payment, { id, status: 'COMPLETED' }, { status: 'REFUNDED', refundAmount, refundedAt: new Date() });
  if (!claimed) throw new AppError('This payment is already being refunded or has been refunded.', 409);
  const release = () => prisma.payment.updateMany({ where: { id, status: 'REFUNDED' }, data: { status: 'COMPLETED', refundAmount: null, refundedAt: null } }).catch(() => {});

  try {
    if (payment.method === 'WALLET') {
      const wallet = await prisma.wallet.findUnique({ where: { userId: payment.userId } });
      if (!wallet) throw new AppError('User wallet not found', 404);
      await prisma.$transaction(async (tx) => {
        await creditWallet(tx, { id: wallet.id }, refundAmount, { currency: payment.currency, refType: 'PAYMENT_REFUND', refId: id, memo: reason, actor: req.user.id });
        await tx.walletTransaction.create({
          data: {
            walletId:    wallet.id,
            type:        'REFUND',
            amount:      refundAmount,
            description: `Payment refund (admin-issued)${reason ? ` — ${reason}` : ''}`,
            status:      'COMPLETED',
            reference:   `ADMIN-REFUND-${id}`,
          },
        });
      });
    } else if (!manuallySettled) {
      // Paystack / Flutterwave refund via the provider that took the payment.
      // Orange Money has no automated refund: refundUnified throws a 501 telling
      // the admin to settle manually and re-submit with manuallySettled.
      await paymentService.refundUnified(refundProvider, payment.transactionId, refundAmount);
    }
    // manuallySettled: the admin already sent the money outside the platform (e.g. an Orange Money transfer). We only
    // record it; the audit entry below keeps who confirmed it.
  } catch (err) {
    await release();   // nothing was refunded: put the payment back so it can be retried
    throw err;
  }

  await notificationService.notify({
    userId:  payment.userId,
    title:   'Refund Issued ✅',
    message: `An admin has issued a refund of ${formatMoney(refundAmount, payment.currency, payment.user.countryCode)} for your payment.${reason ? ` Reason: ${reason}` : ''}`,
    type:    notificationService.TYPES.PAYMENT_REFUNDED,
    data:    { paymentId: id, refundAmount, reason },
  });

  if (payment.user.email) {
    await safeSendEmail(
      () => emailService.sendRefundProcessedEmail(payment.user.email, payment.user.firstName, {
        amount: refundAmount,
        method: payment.method,
        reference: payment.transactionId,
        currency: payment.currency,
      }),
      'Refund processed (admin-issued)'
    );
  }

  await logActivity({
    userId:     req.user.id,
    action:     'admin_refund_issued',
    entityType: 'Payment',
    entityId:   id,
    details:    { refundAmount, currency: payment.currency, reason, method: payment.method, provider: refundProvider, manuallySettled: !!manuallySettled, targetUserId: payment.userId },
    req,
  });

  res.status(200).json({
    success: true,
    message: `${formatMoney(refundAmount, payment.currency, payment.user.countryCode)} refunded successfully.`,
    data:    { paymentId: id, refundAmount },
  });
};
 
exports.getPaymentStats = async (req, res) => {
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const caught = { _sum: { commissionAmount: 0 } };
  const market = marketWhere(req.user, req.query.country);
  const payScope = market ? { user: market } : {};
  const ledgerScope = market ? { earnerUser: market } : {};

  // Everything is grouped by currency: NGN, GHS and XOF amounts can't be added
  // together, so the admin UI shows one set of figures per currency.
  const [
    revenue, todayRevenue, commission, todayCommission,
    pending, refunded, byMethod, byProvider,
  ] = await Promise.all([
    prisma.payment.groupBy({ by: ['currency'], where: { status: 'COMPLETED', ...payScope }, _sum: { amount: true } }),
    prisma.payment.groupBy({ by: ['currency'], where: { status: 'COMPLETED', createdAt: { gte: todayStart }, ...payScope }, _sum: { amount: true } }),
    prisma.commissionLedger.groupBy({ by: ['currency'], where: ledgerScope, _sum: { commissionAmount: true } }).catch(() => []),
    prisma.commissionLedger.groupBy({ by: ['currency'], where: { createdAt: { gte: todayStart }, ...ledgerScope }, _sum: { commissionAmount: true } }).catch(() => []),
    prisma.payment.groupBy({ by: ['currency'], where: { status: 'PENDING', ...payScope }, _count: { id: true } }),
    prisma.payment.groupBy({ by: ['currency'], where: { status: 'REFUNDED', ...payScope }, _sum: { amount: true } }),
    prisma.payment.groupBy({ by: ['currency', 'method'], where: { status: 'COMPLETED', ...payScope }, _sum: { amount: true }, _count: { id: true } }),
    prisma.payment.groupBy({ by: ['currency', 'provider'], where: { status: 'COMPLETED', ...payScope }, _sum: { amount: true }, _count: { id: true } }),
  ]);

  const rows = {};
  const row = (cur) => (rows[cur] ??= {
    currency: cur, totalRevenue: 0, todayRevenue: 0, totalCommission: 0, todayCommission: 0,
    pendingCount: 0, refundedTotal: 0, byMethod: [], byProvider: [],
  });
  revenue.forEach(r         => { row(r.currency).totalRevenue    = r._sum.amount ?? 0; });
  todayRevenue.forEach(r    => { row(r.currency).todayRevenue    = r._sum.amount ?? 0; });
  commission.forEach(r      => { row(r.currency).totalCommission = r._sum.commissionAmount ?? 0; });
  todayCommission.forEach(r => { row(r.currency).todayCommission = r._sum.commissionAmount ?? 0; });
  pending.forEach(r         => { row(r.currency).pendingCount    = r._count.id; });
  refunded.forEach(r        => { row(r.currency).refundedTotal   = r._sum.amount ?? 0; });
  byMethod.forEach(r        => row(r.currency).byMethod.push({ method: r.method, count: r._count.id, total: r._sum.amount ?? 0 }));
  byProvider.forEach(r      => row(r.currency).byProvider.push({ provider: r.provider ?? 'none', count: r._count.id, total: r._sum.amount ?? 0 }));

  const byCurrency = Object.values(rows).sort((a, b) => a.currency.localeCompare(b.currency));

  res.status(200).json({ success: true, data: { byCurrency } });
};

// ─────────────────────────────────────────────
// COMMISSION ANALYTICS
// ─────────────────────────────────────────────

exports.getCommissionAnalytics = async (req, res) => {
  const { from, to, serviceType, days, country } = req.query;
  const earnerMarket = marketWhere(req.user, country);
 
  const [stats, daily] = await Promise.all([
    commissionService.getCommissionStats({
      earnerMarket,
      from:        from ? new Date(from) : undefined,
      to:          to   ? new Date(to)   : undefined,
      serviceType: serviceType || undefined,
    }),
    commissionService.getDailyCommission({
      earnerMarket,
      days:        parseInt(days ?? '30'),
      serviceType: serviceType || undefined,
    }),
  ]);
 
  res.status(200).json({ success: true, data: { ...stats, daily } });
};

// ─────────────────────────────────────────────
// ANALYTICS
// ─────────────────────────────────────────────

exports.getRevenueAnalytics = async (req, res) => {
  const { period = 'month' } = req.query;
  // Revenue is reported for ONE country at a time: amounts in different
  // currencies can't be added. Omitted → Nigeria (what this screen showed
  // before there were other markets).
  const mine = staffMarkets(req.user);
  const countryCode = String(req.query.country || mine[0] || 'NG').toUpperCase();
  if (mine.length && !mine.includes(countryCode)) throw new AppError('That country is outside your assigned countries.', 403);
  const country = await prisma.country.findUnique({ where: { code: countryCode }, select: { code: true, name: true, currencyCode: true } });
  const currency = country?.currencyCode ?? 'NGN';

  let startDate = new Date();
  if (period === 'week')  startDate.setDate(startDate.getDate() - 7);
  else if (period === 'month') startDate.setMonth(startDate.getMonth() - 1);
  else if (period === 'year')  startDate.setFullYear(startDate.getFullYear() - 1);

  const payments = await prisma.payment.findMany({
    where: { status: 'COMPLETED', createdAt: { gte: startDate }, user: { countryCode } },
    select: { amount: true, platformFee: true, createdAt: true, rideId: true, deliveryId: true, method: true },
    orderBy: { createdAt: 'asc' },
  });
  const revenueByDate = {};
  payments.forEach(p => {
    const date = p.createdAt.toISOString().split('T')[0];
    if (!revenueByDate[date]) revenueByDate[date] = { date, total: 0, rides: 0, deliveries: 0, count: 0 };
    revenueByDate[date].total += p.amount;
    revenueByDate[date].count++;
    if (p.rideId)     revenueByDate[date].rides     += p.amount;
    if (p.deliveryId) revenueByDate[date].deliveries += p.amount;
  });
  const totalRevenue = payments.reduce((sum, p) => sum + p.amount, 0);
  // The fee actually recorded on each payment at the rate in force THEN — not
  // today's rate applied retroactively, which is wrong the moment a rate changes.
  const platformFee  = payments.reduce((sum, p) => sum + (p.platformFee ?? 0), 0);
  const byMethod = {};
  payments.forEach(p => { byMethod[p.method] = (byMethod[p.method] || 0) + p.amount; });

  res.status(200).json({ success: true, data: {
    totalRevenue,
    platformFee:  Math.round(platformFee),
    netRevenue:   Math.round(totalRevenue - platformFee),
    transactionCount: payments.length,
    dailyRevenue: Object.values(revenueByDate),
    byMethod,
    period,
    country:  countryCode,
    countryName: country?.name ?? countryCode,
    currency,
  }});
};

exports.getPerformanceAnalytics = async (req, res) => {
  const { period = 'week' } = req.query;
  const market = marketWhere(req.user, req.query.country);
  const viaCustomer = market ? { customer: market } : {};
 
  let startDate = new Date();
  if (period === 'week')  startDate.setDate(startDate.getDate() - 7);
  else if (period === 'month') startDate.setMonth(startDate.getMonth() - 1);
  else if (period === 'year')  startDate.setFullYear(startDate.getFullYear() - 1);
 
  const dateFilter = { gte: startDate };
 
  const [
    completedRides,
    cancelledRides,
    completedDeliveries,
    cancelledDeliveries,
    ridesWithDuration,
    deliveriesWithDuration,
    driverRatingAgg,
    partnerRatingAgg,
    dailyRides,
    dailyDeliveries,
  ] = await Promise.all([
    prisma.ride.count({ where: { status: 'COMPLETED',  requestedAt: dateFilter, ...viaCustomer } }),
    prisma.ride.count({ where: { status: 'CANCELLED',  requestedAt: dateFilter, ...viaCustomer } }),
    prisma.delivery.count({ where: { status: 'DELIVERED', requestedAt: dateFilter, ...viaCustomer } }),
    prisma.delivery.count({ where: { status: 'CANCELLED', requestedAt: dateFilter, ...viaCustomer } }),
 
    // Average ride duration in minutes (completedAt - acceptedAt, both must exist)
    prisma.ride.findMany({
      where: {
        status: 'COMPLETED',
        requestedAt: dateFilter,
        acceptedAt:  { not: null },
        completedAt: { not: null },
        ...viaCustomer,
      },
      select: { acceptedAt: true, completedAt: true },
    }),
 
    // Average delivery duration in minutes (deliveredAt - assignedAt, both must exist)
    prisma.delivery.findMany({
      where: {
        status: 'DELIVERED',
        requestedAt: dateFilter,
        assignedAt:  { not: null },
        deliveredAt: { not: null },
        ...viaCustomer,
      },
      select: { assignedAt: true, deliveredAt: true },
    }),
 
    // Average driver rating (from Rating table, linked via rideId)
    prisma.rating.aggregate({
      where: { ride: { requestedAt: dateFilter, ...viaCustomer }, driverRating: { not: null } },
      _avg: { driverRating: true },
    }).catch(() => ({ _avg: { driverRating: null } })),
 
    // Average delivery partner rating
    prisma.rating.aggregate({
      where: { delivery: { requestedAt: dateFilter, ...viaCustomer }, partnerRating: { not: null } },
      _avg: { partnerRating: true },
    }).catch(() => ({ _avg: { partnerRating: null } })),
 
    // Daily breakdown for rides (last 7 days always shown)
    prisma.ride.findMany({
      where: { requestedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }, ...viaCustomer },
      select: { status: true, requestedAt: true },
    }),
 
    prisma.delivery.findMany({
      where: { requestedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }, ...viaCustomer },
      select: { status: true, requestedAt: true },
    }),
  ]);
 
  // ── Derived metrics ──────────────────────────────────────────────────────
 
  const totalRides      = completedRides + cancelledRides;
  const totalDeliveries = completedDeliveries + cancelledDeliveries;
 
  const rideCompletionRate     = totalRides      > 0 ? (completedRides      / totalRides)      * 100 : 0;
  const deliveryCompletionRate = totalDeliveries > 0 ? (completedDeliveries / totalDeliveries) * 100 : 0;
  const overallCompletionRate  = (totalRides + totalDeliveries) > 0
    ? ((completedRides + completedDeliveries) / (totalRides + totalDeliveries)) * 100
    : 0;
 
  const avgRideMinutes = ridesWithDuration.length > 0
    ? ridesWithDuration.reduce((sum, r) => {
        return sum + (new Date(r.completedAt).getTime() - new Date(r.acceptedAt).getTime());
      }, 0) / ridesWithDuration.length / 60_000
    : null;
 
  const avgDeliveryMinutes = deliveriesWithDuration.length > 0
    ? deliveriesWithDuration.reduce((sum, d) => {
        return sum + (new Date(d.deliveredAt).getTime() - new Date(d.assignedAt).getTime());
      }, 0) / deliveriesWithDuration.length / 60_000
    : null;
 
  // ── Weekly activity by day ───────────────────────────────────────────────
 
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayMap = {};
  DAY_NAMES.forEach(d => { dayMap[d] = { day: d, rides: 0, deliveries: 0 }; });
 
  dailyRides.forEach(r => {
    const day = DAY_NAMES[new Date(r.requestedAt).getDay()];
    dayMap[day].rides++;
  });
  dailyDeliveries.forEach(d => {
    const day = DAY_NAMES[new Date(d.requestedAt).getDay()];
    dayMap[day].deliveries++;
  });
 
  // Return in Mon→Sun order
  const weeklyActivity = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    .map(d => dayMap[d]);
 
  // ── Completion vs cancellation pie data ──────────────────────────────────
 
  const completionData = [
    { name: 'Completed', value: parseFloat(overallCompletionRate.toFixed(1)) },
    { name: 'Cancelled', value: parseFloat((100 - overallCompletionRate).toFixed(1)) },
  ];
 
  res.status(200).json({
    success: true,
    data: {
      period,
      metrics: {
        averageRideTime:      avgRideMinutes     !== null ? parseFloat(avgRideMinutes.toFixed(1))     : null,
        averageDeliveryTime:  avgDeliveryMinutes !== null ? parseFloat(avgDeliveryMinutes.toFixed(1)) : null,
        driverRating:         driverRatingAgg._avg.driverRating  !== null
                                ? parseFloat((driverRatingAgg._avg.driverRating ?? 0).toFixed(1))  : null,
        partnerRating:        partnerRatingAgg._avg.partnerRating !== null
                                ? parseFloat((partnerRatingAgg._avg.partnerRating ?? 0).toFixed(1)) : null,
        completionRate:       parseFloat(overallCompletionRate.toFixed(1)),
        rideCompletionRate:   parseFloat(rideCompletionRate.toFixed(1)),
        deliveryCompletionRate: parseFloat(deliveryCompletionRate.toFixed(1)),
        cancellationRate:     parseFloat((100 - overallCompletionRate).toFixed(1)),
        totalRides,
        totalDeliveries,
        completedRides,
        completedDeliveries,
        cancelledRides,
        cancelledDeliveries,
      },
      weeklyActivity,
      completionData,
    },
  });
};

exports.getUserGrowth = async (req, res) => {
  const { period = 'month' } = req.query;
  const market = marketWhere(req.user, req.query.country);
  let startDate = new Date();
  if (period === 'month') startDate.setMonth(startDate.getMonth() - 6);
  else if (period === 'year') startDate.setFullYear(startDate.getFullYear() - 1);
  const users = await prisma.user.findMany({ where: { createdAt: { gte: startDate }, ...(market || {}) }, select: { role: true, createdAt: true }, orderBy: { createdAt: 'asc' } });
  const growthByMonth = {};
  users.forEach(u => {
    const month = u.createdAt.toISOString().slice(0, 7);
    if (!growthByMonth[month]) growthByMonth[month] = { month, customers: 0, drivers: 0, partners: 0, total: 0 };
    growthByMonth[month].total++;
    if (u.role === 'CUSTOMER')         growthByMonth[month].customers++;
    if (u.role === 'DRIVER')           growthByMonth[month].drivers++;
    if (u.role === 'DELIVERY_PARTNER') growthByMonth[month].partners++;
  });
  res.status(200).json({ success: true, data: { growth: Object.values(growthByMonth), totalUsers: users.length, period } });
};

// ─────────────────────────────────────────────
// SYSTEM SETTINGS — busts fare cache on every save
// ─────────────────────────────────────────────

exports.getSettings = async (req, res) => {
  const { category } = req.query;
  const settings = await prisma.systemSettings.findMany({ where: category ? { category } : {} });
  const settingsMap = {};
  settings.forEach(s => { settingsMap[s.key] = { value: s.value, category: s.category, description: s.description }; });
  res.status(200).json({ success: true, data: { settings: settingsMap } });
};

exports.updateSetting = async (req, res) => {
  const { key } = req.params;
  const { value, category, description } = req.body;
  if (value === undefined) throw new AppError('Value is required', 400);

  const setting = await prisma.systemSettings.upsert({
    where:  { key },
    update: { value, updatedBy: req.user.id, ...(description && { description }) },
    create: { key, value, category: category || 'general', description, updatedBy: req.user.id },
  });

  // Bust fare engine cache so pricing is live immediately
  invalidateFareCache();

  // Bust maintenance cache so the new state takes effect immediately
  if (['maintenance_mode', 'maintenance_message', 'maintenance_starts_at', 'maintenance_ends_at'].includes(key)) {
  invalidateMaintenanceCache();
  }

  await logActivity({ userId: req.user.id, action: 'setting_updated', entityType: 'SystemSettings', entityId: setting.id, details: { key, value }, req });
  res.status(200).json({ success: true, message: 'Setting updated', data: { setting } });
};

exports.updateSettingsBatch = async (req, res) => {
  const { settings } = req.body;
  if (!Array.isArray(settings) || settings.length === 0)
    throw new AppError('settings array is required', 400);

  const results = await prisma.$transaction(
    settings.map(({ key, value, category = 'general', description }) =>
      prisma.systemSettings.upsert({
        where:  { key },
        update: { value, updatedBy: req.user.id, ...(description && { description }) },
        create: { key, value, category, description, updatedBy: req.user.id },
      })
    )
  );

  const keys = settings.map(s => s.key);

  // Bust caches for any relevant keys
  invalidateFareCache();
  if (keys.some(k => k.startsWith('maintenance'))) invalidateMaintenanceCache();

  await logActivity({
    userId:     req.user.id,
    action:     'settings_batch_updated',
    entityType: 'SystemSettings',
    entityId:   null,
    details:    { keys },
    req,
  });

  res.json({ success: true, message: 'Settings updated', data: { settings: results } });
};

// ─────────────────────────────────────────────
// PROMO CODES
// ─────────────────────────────────────────────

exports.getPromoCodes = async (req, res) => {
  const { page = 1, limit = 20, isActive } = req.query;
  const skip = (page - 1) * limit;
  const where = {};
  if (isActive !== undefined) where.isActive = isActive === 'true';
  const [codes, total] = await Promise.all([prisma.promoCode.findMany({ where, skip: parseInt(skip), take: parseInt(limit), orderBy: { createdAt: 'desc' } }), prisma.promoCode.count({ where })]);
  res.status(200).json({ success: true, data: { codes, pagination: { total, page: parseInt(page), pages: Math.ceil(total / limit) } } });
};

exports.createPromoCode = async (req, res) => {
  const { code, description, discountType, discountValue, maxUses, maxUsesPerUser, minPurchaseAmount, validFrom, validUntil, applicableFor } = req.body;
  const existing = await prisma.promoCode.findUnique({ where: { code: code.toUpperCase() } });
  if (existing) throw new AppError('Promo code already exists', 400);
  const promo = await prisma.promoCode.create({ data: { code: code.toUpperCase(), description, discountType, discountValue, maxUses, maxUsesPerUser: maxUsesPerUser || 1, minPurchaseAmount, validFrom: new Date(validFrom), validUntil: new Date(validUntil), applicableFor } });
  res.status(201).json({ success: true, message: 'Promo code created', data: { promo } });
};

exports.togglePromoCode = async (req, res) => {
  const { id } = req.params;
  const promo = await prisma.promoCode.findUnique({ where: { id } });
  if (!promo) throw new AppError('Promo code not found', 404);
  const updated = await prisma.promoCode.update({ where: { id }, data: { isActive: !promo.isActive } });
  res.status(200).json({ success: true, message: `Promo code ${updated.isActive ? 'activated' : 'deactivated'}`, data: { promo: updated } });
};

// ─────────────────────────────────────────────
// ACTIVITY LOGS
// ─────────────────────────────────────────────

exports.getActivityLogs = async (req, res) => {
  const { page = 1, limit = 50, action, entityType, userId } = req.query;
  const skip = (page - 1) * limit;
  const where = {};
  if (action)     where.action     = action;
  if (entityType) where.entityType = entityType;
  if (userId)     where.userId     = userId;
  const [logs, total] = await Promise.all([
    prisma.activityLog.findMany({ where, include: { user: { select: { firstName: true, lastName: true, email: true } } }, skip: parseInt(skip), take: parseInt(limit), orderBy: { createdAt: 'desc' } }),
    prisma.activityLog.count({ where }),
  ]);
  res.status(200).json({ success: true, data: { logs, pagination: { total, page: parseInt(page), pages: Math.ceil(total / limit) } } });
};

// ─────────────────────────────────────────────
// WALLET MANAGEMENT
// ─────────────────────────────────────────────

exports.getWallets = async (req, res) => {
  const { page = 1, limit = 20, minBalance, currency, country } = req.query;
  const skip = (page - 1) * limit;
  const where = {};
  const walletMarket = marketWhere(req.user, country);
  if (walletMarket) where.user = walletMarket;
  if (minBalance) where.balance = { gte: parseFloat(minBalance) };
  if (currency)   where.currency = String(currency).toUpperCase();
  const [wallets, total, totalsByCurrency] = await Promise.all([
    prisma.wallet.findMany({ where, include: { user: { select: { firstName: true, lastName: true, email: true, role: true } } }, skip: parseInt(skip), take: parseInt(limit), orderBy: { balance: 'desc' } }),
    prisma.wallet.count({ where }),
    // One total per currency — a single sum across currencies is meaningless.
    prisma.wallet.groupBy({ by: ['currency'], where, _sum: { balance: true } }),
  ]);
  res.status(200).json({ success: true, data: { wallets, totalsByCurrency: totalsByCurrency.map(t => ({ currency: t.currency, total: t._sum.balance || 0 })), pagination: { total, page: parseInt(page), pages: Math.ceil(total / limit) } } });
};

// Largest single manual adjustment staff may make without a Super Admin. Overridable per deployment.
const adjustLimit = () => { const n = Number(process.env.ADMIN_WALLET_ADJUST_MAX); return Number.isFinite(n) && n > 0 ? n : 500000; };

exports.adjustWallet = async (req, res) => {
  const { userId } = req.params;
  const amount = Number(req.body.amount);
  const { type } = req.body;
  const reason = String(req.body.reason ?? '').trim();
  if (!Number.isFinite(amount) || amount <= 0) throw new AppError('Valid amount is required', 400);
  if (!['credit', 'debit'].includes(type)) throw new AppError('Type must be credit or debit', 400);
  if (userId === req.user.id) throw new AppError('You cannot adjust your own wallet.', 403);
  // Moving someone's money without a stated reason cannot be reviewed later.
  if (reason.length < 5) throw new AppError('A reason of at least 5 characters is required for a wallet adjustment.', 400);
  if (amount > adjustLimit() && req.user.role !== 'SUPER_ADMIN')
    throw new AppError(`Adjustments above ${adjustLimit()} need a Super Admin.`, 403);

  const wallet = await prisma.wallet.findUnique({
    where: { userId },
    include: { user: { select: { firstName: true, email: true, countryCode: true } } },
  });
  if (!wallet) throw new AppError('Wallet not found', 404);
  if (isWholeUnitCurrency(wallet.currency) && !Number.isInteger(amount)) {
    throw new AppError(`${wallet.currency} has no decimals — enter a whole amount.`, 400);
  }

  // ONE database-side change inside a transaction: a debit only succeeds if the balance still covers it, and a
  // credit is added to whatever the balance is NOW (the old code wrote back a balance it had read earlier, so a
  // payment landing in between was silently erased).
  const reference = newReference('ADMIN');
  const [updatedWallet, transaction] = await prisma.$transaction(async (tx) => {
    const meta = { currency: wallet.currency, refType: 'ADMIN_WALLET_ADJUST', refId: reference, memo: reason, actor: req.user.id };
    if (type === 'debit') await debitWallet(tx, { id: wallet.id }, amount, meta);
    else await creditWallet(tx, { id: wallet.id }, amount, meta);
    const w = await tx.wallet.findUnique({ where: { id: wallet.id } });
    const t = await tx.walletTransaction.create({ data: { walletId: wallet.id, type: type === 'credit' ? 'CREDIT' : 'DEBIT', amount, description: reason, status: 'COMPLETED', reference } });
    return [w, t];
  });

  await notificationService.notify({ userId, title: type === 'credit' ? 'Wallet Credited 💰' : 'Wallet Debited', message: `Your wallet has been ${type}ed with ${formatMoney(amount, wallet.currency, wallet.user?.countryCode)}.${reason ? ` Reason: ${reason}` : ''}`, type: notificationService.TYPES.PAYMENT_RECEIVED, data: { amount, currency: wallet.currency, type, reason } });

  if (wallet.user?.email) {
    await safeSendEmail(
      () => emailService.sendWalletAdjustmentEmail(wallet.user.email, wallet.user.firstName, { amount, type, reason, currency: wallet.currency }),
      'Wallet adjustment'
    );
  }

  await logActivity({ userId: req.user.id, action: `wallet_${type}`, entityType: 'Wallet', entityId: wallet.id, details: { amount, currency: wallet.currency, reason, targetUserId: userId, reference }, req });
  res.status(200).json({ success: true, message: `Wallet ${type}ed successfully`, data: { wallet: updatedWallet, transaction } });
};

// ─────────────────────────────────────────────
// BROADCAST NOTIFICATIONS
// ─────────────────────────────────────────────

exports.broadcastNotification = async (req, res) => {
  const { title, message, type = 'admin_broadcast', role } = req.body;
  if (!title || !message) throw new AppError('Title and message are required', 400);

  // ── Quiet hours check ──────────────────────────────────────────────────
  const quietSettings = await prisma.systemSettings.findMany({
    where: { key: { in: ['notifications_quiet_hours_start', 'notifications_quiet_hours_end'] } },
  });
  const qs = Object.fromEntries(quietSettings.map(s => [s.key, parseInt(s.value)]));
  const quietStart = qs['notifications_quiet_hours_start'] ?? 23;
  const quietEnd   = qs['notifications_quiet_hours_end']   ?? 7;
  const currentHour = new Date().getHours();

  const inQuietHours = quietStart > quietEnd
    ? currentHour >= quietStart || currentHour < quietEnd   // overnight window e.g. 23→7
    : currentHour >= quietStart && currentHour < quietEnd;  // same-day window

  if (inQuietHours) {
    throw new AppError(
      `Broadcasts are blocked during quiet hours (${quietStart}:00–${quietEnd}:00). Schedule for later.`,
      403
    );
  }

  // A country-limited admin can only message users in their own countries.
  const where = { isActive: true, ...(marketWhere(req.user, req.body.country) || {}) };
  if (role) where.role = role;
  const users = await prisma.user.findMany({ where, select: { id: true } });
  await prisma.notification.createMany({ data: users.map(u => ({ userId: u.id, title, message, type, data: { broadcast: true, sentBy: req.user.id } })) });
  if (notificationService._io) {
    users.forEach(u => { notificationService._io.to(`user:${u.id}`).emit('notification', { title, message, type, data: { broadcast: true }, createdAt: new Date() }); });
  }
  await logActivity({ userId: req.user.id, action: 'broadcast_notification', entityType: 'Notification', entityId: null, details: { title, message, type, recipientCount: users.length, role }, req });
  res.status(200).json({ success: true, message: `Notification sent to ${users.length} user(s)`, data: { recipientCount: users.length } });
};

// ─────────────────────────────────────────────
// ONBOARDING BONUS BULK DISBURSEMENT
// SUPER_ADMIN only — credits all approved drivers/partners at ₦0 balance
// ─────────────────────────────────────────────
// Groups eligible earners by their country so each is paid in their own
// currency. `overrides` is { NG: { driver, partner }, ML: {...} } from the admin;
// anything not overridden uses that country's configured onboarding bonus.
// Legacy `driverBonus` / `partnerBonus` (single numbers) are honoured ONLY for
// base-currency (NGN) recipients — applying one number across currencies is the
// bug this replaces.
const planBonusesByCountry = async ({ driversEligible, partnersEligible, overrides = {}, legacyDriver, legacyPartner, allDrivers = [], allPartners = [] }) => {
  const plan = {};
  const ensure = (cc) => (plan[cc] ??= { countryCode: cc, drivers: [], partners: [], driverBonus: 0, partnerBonus: 0, currency: null });

  for (const d of driversEligible)  ensure(d.user.countryCode ?? 'NG').drivers.push(d);
  for (const p of partnersEligible) ensure(p.user.countryCode ?? 'NG').partners.push(p);

  for (const cc of Object.keys(plan)) {
    const eff = await countrySettingsService.getEffectiveSettings(cc);
    const o = overrides[cc] ?? {};
    const legacyOk = eff.currency === countrySettingsService.BASE_CURRENCY;
    plan[cc].currency     = eff.currency;
    plan[cc].driverBonus  = await bonusFor('driver',  cc, o.driver  ?? (legacyOk ? legacyDriver  : undefined));
    plan[cc].partnerBonus = await bonusFor('partner', cc, o.partner ?? (legacyOk ? legacyPartner : undefined));
  }
  return plan;
};

exports.previewOnboardingBonuses = async (req, res) => {
  if (!hasCountryAuthority(req.user))
    throw new AppError('Only a Super Admin or a country admin can preview onboarding bonuses', 403);

  const { allDrivers, allPartners, driversEligible, partnersEligible } =
    await fetchBonusCandidates(marketWhere(req.user, req.query.country));

  const plan = await planBonusesByCountry({ driversEligible, partnersEligible });

  res.status(200).json({
    success: true,
    data: {
      drivers: {
        total:             allDrivers.length,
        eligible:          driversEligible.length,
        alreadyBonused:    allDrivers.length - driversEligible.length,
        totalWalletBalance: allDrivers.reduce(
          (sum, d) => sum + (d.user.wallet?.balance ?? 0), 0
        ),
      },
      partners: {
        total:             allPartners.length,
        eligible:          partnersEligible.length,
        alreadyBonused:    allPartners.length - partnersEligible.length,
        totalWalletBalance: allPartners.reduce(
          (sum, p) => sum + (p.user.wallet?.balance ?? 0), 0
        ),
      },
      // One row per country: who gets what, in which currency.
      byCountry: Object.values(plan).map(c => ({
        countryCode:  c.countryCode,
        currency:     c.currency,
        drivers:      c.drivers.length,
        partners:     c.partners.length,
        driverBonus:  c.driverBonus,
        partnerBonus: c.partnerBonus,
        total:        c.driverBonus * c.drivers.length + c.partnerBonus * c.partners.length,
      })),
    },
  });
};

exports.disburseOnboardingBonuses = async (req, res) => {
  if (!hasCountryAuthority(req.user))
    throw new AppError('Only a Super Admin or a country admin can disburse onboarding bonuses', 403);

  const { driverBonus: legacyDriver, partnerBonus: legacyPartner, overrides = {}, countryCodes } = req.body;
  for (const v of [legacyDriver, legacyPartner, ...Object.values(overrides).flatMap(o => [o?.driver, o?.partner])]) {
    if (v !== undefined && v !== null && (!Number.isFinite(Number(v)) || Number(v) < 0))
      throw new AppError('Bonus amounts must be positive', 400);
  }

  let { driversEligible, partnersEligible } = await fetchBonusCandidates(marketWhere(req.user, undefined));

  // Optionally restrict the run to specific countries.
  if (Array.isArray(countryCodes) && countryCodes.length) {
    const only = new Set(countryCodes.map(c => String(c).toUpperCase()));
    driversEligible  = driversEligible.filter(d => only.has(d.user.countryCode ?? 'NG'));
    partnersEligible = partnersEligible.filter(p => only.has(p.user.countryCode ?? 'NG'));
  }

  if (driversEligible.length === 0 && partnersEligible.length === 0) {
    return res.status(200).json({
      success: true,
      message: 'No eligible recipients — all approved drivers and partners have already received an onboarding bonus.',
      data: { drivers: 0, partners: 0, totalDisbursed: 0, byCountry: [] },
    });
  }

  const plan = await planBonusesByCountry({ driversEligible, partnersEligible, overrides, legacyDriver, legacyPartner });
  const driverAmt  = (u) => plan[u.countryCode ?? 'NG'].driverBonus;
  const partnerAmt = (u) => plan[u.countryCode ?? 'NG'].partnerBonus;

  const REF = `ONBOARDING-${Date.now()}`;

  // Zero-amount countries (no bonus configured) are skipped rather than
  // creating empty ₀ credits.
  driversEligible  = driversEligible.filter(d => driverAmt(d.user)  > 0);
  partnersEligible = partnersEligible.filter(p => partnerAmt(p.user) > 0);

  await prisma.$transaction([
    ...driversEligible.flatMap(driver => [
      prisma.wallet.update({
        where: { id: driver.user.wallet.id },
        data:  { balance: { increment: driverAmt(driver.user) } },
      }),
      prisma.walletTransaction.create({
        data: {
          walletId:    driver.user.wallet.id,
          type:        'CREDIT',
          amount:      driverAmt(driver.user),
          description: 'Onboarding bonus — non-withdrawable, for accepting rides only',
          status:      'COMPLETED',
          reference:   `ONBOARDING-DRV-${driver.user.id}-${REF}`,
        },
      }),
    ]),
    ...partnersEligible.flatMap(partner => [
      prisma.wallet.update({
        where: { id: partner.user.wallet.id },
        data:  { balance: { increment: partnerAmt(partner.user) } },
      }),
      prisma.walletTransaction.create({
        data: {
          walletId:    partner.user.wallet.id,
          type:        'CREDIT',
          amount:      partnerAmt(partner.user),
          description: 'Onboarding bonus — non-withdrawable, for accepting deliveries only',
          status:      'COMPLETED',
          reference:   `ONBOARDING-PTR-${partner.user.id}-${REF}`,
        },
      }),
    ]),
  ]);

  const money = (amt, u) => formatMoney(amt, u.wallet?.currency, u.countryCode);

  await Promise.all([
    ...driversEligible.map(driver =>
      notificationService.notify({
        userId:  driver.user.id,
        title:   '🎁 Onboarding Bonus Received!',
        message: `${money(driverAmt(driver.user), driver.user)} has been credited to your wallet. You can now start accepting rides. Welcome to Runserv!`,
        type:    notificationService.TYPES?.PAYMENT_RECEIVED ?? 'payment_received',
        data:    { amount: driverAmt(driver.user), type: 'onboarding_bonus' },
      })
    ),
    ...partnersEligible.map(partner =>
      notificationService.notify({
        userId:  partner.user.id,
        title:   '🎁 Onboarding Bonus Received!',
        message: `${money(partnerAmt(partner.user), partner.user)} has been credited to your wallet. You can now start accepting deliveries. Welcome to Runserv!`,
        type:    notificationService.TYPES?.PAYMENT_RECEIVED ?? 'payment_received',
        data:    { amount: partnerAmt(partner.user), type: 'onboarding_bonus' },
      })
    ),
  ]);

  // ── Email notifications — non-fatal, fired in parallel, each isolated so
  // one bad address never breaks the batch or blocks the response. ─────────
  await Promise.allSettled([
    ...driversEligible.map(driver =>
      driver.user.email
        ? safeSendEmail(
            () => emailService.sendBonusEmail(driver.user.email, driver.user.firstName, {
              amount: driverAmt(driver.user),
              currency: driver.user.wallet?.currency,
              withdrawable: false,
              description: 'Onboarding bonus for accepting rides on Runserv.',
            }),
            `Driver onboarding bonus (${driver.user.id})`
          )
        : Promise.resolve()
    ),
    ...partnersEligible.map(partner =>
      partner.user.email
        ? safeSendEmail(
            () => emailService.sendBonusEmail(partner.user.email, partner.user.firstName, {
              amount: partnerAmt(partner.user),
              currency: partner.user.wallet?.currency,
              withdrawable: false,
              description: 'Onboarding bonus for accepting deliveries on Runserv.',
            }),
            `Partner onboarding bonus (${partner.user.id})`
          )
        : Promise.resolve()
    ),
  ]);

  const driverCount  = driversEligible.length;
  const partnerCount = partnersEligible.length;
  const byCountry = Object.values(plan).map(c => {
    const d = c.drivers.filter(x => c.driverBonus  > 0).length;
    const p = c.partners.filter(x => c.partnerBonus > 0).length;
    return { countryCode: c.countryCode, currency: c.currency, drivers: d, partners: p,
             driverBonus: c.driverBonus, partnerBonus: c.partnerBonus,
             total: c.driverBonus * d + c.partnerBonus * p };
  });

  await logActivity({
    userId:     req.user.id,
    action:     'onboarding_bonus_disbursed',
    entityType: 'Wallet',
    entityId:   null,
    details:    { driverCount, partnerCount, byCountry },
    req,
  });

  res.status(200).json({
    success: true,
    message: `Onboarding bonus disbursed to ${driverCount} driver(s) and ${partnerCount} delivery partner(s).`,
    // Totals are per country because they're in different currencies — one
    // summed number would be meaningless.
    data:    { drivers: driverCount, partners: partnerCount, byCountry },
  });
};
 

exports.disburseCustomBonuses = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  const { userIds, description = '', nonWithdrawable = false } = req.body;
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new AppError('Enter a valid bonus amount.', 400);
  if (!Array.isArray(userIds) || userIds.length > 200) throw new AppError('Select between 1 and 200 recipients.', 400);
  if (amount > adjustLimit() && req.user.role !== 'SUPER_ADMIN') throw new AppError(`Bonuses above ${adjustLimit()} per person need a Super Admin.`, 403);

  // Fetch wallets for all specified users (only those that exist and belong to driver/partner)
  const wallets = await prisma.wallet.findMany({
    where: {
      userId: { in: userIds },
      user:   { role: { in: ['DRIVER', 'DELIVERY_PARTNER'] }, ...(marketWhere(req.user, undefined) || {}) },  // earners, in the admin's countries
    },
    include: { user: { select: { id: true, firstName: true, lastName: true, role: true, email: true, countryCode: true } } },
  });

  // One flat amount can only be paid in ONE currency. Mixed recipients would get
  // e.g. 5,000 NGN and 5,000 XOF for the same "5,000" — refuse and ask for a
  // separate disbursement per currency.
  const bonusCurrencies = [...new Set(wallets.map(w => w.currency))];
  if (bonusCurrencies.length > 1) {
    return res.status(400).json({
      success: false,
      message: `Selected recipients hold wallets in different currencies (${bonusCurrencies.join(', ')}). Send one bonus per currency.`,
    });
  }
  const bonusCurrency = bonusCurrencies[0] ?? 'NGN';
  if (isWholeUnitCurrency(bonusCurrency) && !Number.isInteger(amount)) {
    return res.status(400).json({ success: false, message: `${bonusCurrency} has no decimals — enter a whole amount.` });
  }

  const foundIds    = wallets.map(w => w.userId);
  const missing     = userIds.filter(id => !foundIds.includes(id));
  if (missing.length) {
    return res.status(400).json({
      success: false,
      message: `Some users not found or are not drivers/partners: ${missing.join(', ')}`,
    });
  }

  const BONUS_REF_PREFIX = nonWithdrawable ? 'BONUS-NW-' : 'BONUS-';
  // The reference is derived from WHAT is being paid (who, how much, by whom, within a 10-minute window), so a double
  // click or a replayed request hits the unique-reference rule and is refused instead of paying everyone twice.
  const bucket           = Math.floor(Date.now() / 600000);
  const refBase          = `${BONUS_REF_PREFIX}${require('crypto').createHash('sha256').update([req.user.id, amount, description, [...userIds].sort().join(','), bucket].join('|')).digest('base64url').slice(0, 16)}`;
  const transactions     = [];

  // Perform all wallet updates in parallel for speed but inside a safe loop
 // Single atomic transaction for all wallet ops
  try {
  await prisma.$transaction(
    wallets.flatMap((wallet, index) => [
      prisma.wallet.update({
        where: { id: wallet.id },
        data:  { balance: { increment: amount } },
      }),
      prisma.walletTransaction.create({
        data: {
          walletId:    wallet.id,
          type:        'CREDIT',
          amount,
          description: `${description || 'Admin bonus'}${nonWithdrawable ? ' (non‑withdrawable)' : ''}`,
          status:      'COMPLETED',
          reference:   `${refBase}-${index}`,
        },
      }),
    ])
  );
  } catch (err) {
    if (err?.code === 'P2002') throw new AppError('This exact bonus was already paid a moment ago. Check the recipients\' wallets before sending it again.', 409);
    throw err;
  }

  // Notifications after commit — parallel, non-blocking
  await Promise.all(wallets.map(wallet =>
    notificationService.notify({
      userId:  wallet.user.id,
      title:   '🎁 Bonus Received!',
      message: `${formatMoney(amount, bonusCurrency, wallet.user.countryCode)} has been credited to your wallet.${nonWithdrawable ? ' This is non‑withdrawable and can only be used for rides/deliveries.' : ''}`,
      type:    notificationService.TYPES?.PAYMENT_RECEIVED ?? 'payment_received',
      data:    { amount, nonWithdrawable, creditedBy: req.user.id },
    })
  ));

  // Email notifications — non-fatal, one per recipient, isolated failures
  await Promise.allSettled(wallets.map(wallet =>
    wallet.user.email
      ? safeSendEmail(
          () => emailService.sendBonusEmail(wallet.user.email, wallet.user.firstName, {
            amount,
            withdrawable: !nonWithdrawable,
            description: description || undefined,
            currency: bonusCurrency,
          }),
          `Custom bonus (${wallet.user.id})`
        )
      : Promise.resolve()
  ));

  // Log the action
  await logActivity({
    userId:     req.user.id,
    action:     'custom_bonus_disbursed',
    entityType: 'Wallet',
    entityId:   null,
    details:    {
      userIds: foundIds,
      amount,
      currency: bonusCurrency,
      description,
      nonWithdrawable,
      totalDisbursed: amount * wallets.length,
      recipientsCount: wallets.length,
    },
    req,
  });

  res.status(200).json({
    success: true,
    message: `Bonus of ${formatMoney(amount, bonusCurrency)} credited to ${wallets.length} user(s).`,
    data:    {
      credited: wallets.length,
      amount,
      totalDisbursed: amount * wallets.length,
      currency: bonusCurrency,
    },
  });
};

// ─── DELIVERY DETAIL + LIVE + CANCEL ─────────────────────────────────────────

exports.getDeliveryById = async (req, res) => {
  const { id } = req.params;
 
  const delivery = await prisma.delivery.findUnique({
    where: { id },
    include: {
      customer: {
        select: { id: true, firstName: true, lastName: true, email: true, phone: true, profileImage: true },
      },
      partner: {
        select: {
          id: true, firstName: true, lastName: true, email: true, phone: true, profileImage: true,
          deliveryProfile: {
            select: {
              vehicleType: true, vehiclePlate: true, rating: true,
              currentLat: true, currentLng: true, // live location
            },
          },
        },
      },
      payment: true,
      rating: true,
    },
  });
 
  if (!delivery) throw new AppError('Delivery not found', 404);
 
  // Build a timeline from status-change timestamps
  const timeline = [
    { event: 'Requested',   at: delivery.requestedAt,  done: !!delivery.requestedAt },
    { event: 'Assigned',    at: delivery.assignedAt,   done: !!delivery.assignedAt  },
    { event: 'Picked Up',   at: delivery.pickedUpAt,   done: !!delivery.pickedUpAt  },
    { event: 'In Transit',  at: delivery.inTransitAt,  done: !!delivery.inTransitAt },
    { event: 'Delivered',   at: delivery.deliveredAt,  done: !!delivery.deliveredAt },
  ].filter(t => t.at);
 
  res.status(200).json({ success: true, data: { delivery, timeline } });
};

exports.getLiveDeliveries = async (req, res) => {
  const market = marketWhere(req.user, req.query.country);
  const deliveries = await prisma.delivery.findMany({
    where: { status: { in: ['ASSIGNED', 'PICKED_UP', 'IN_TRANSIT'] }, ...(market ? { customer: market } : {}) },
    include: {
      customer: { select: { id: true, firstName: true, lastName: true, phone: true, countryCode: true } },
      partner: {
        select: {
          id: true, firstName: true, lastName: true, phone: true, profileImage: true,
          deliveryProfile: {
            select: { vehicleType: true, vehiclePlate: true, currentLat: true, currentLng: true },
          },
        },
      },
    },
    orderBy: { assignedAt: 'desc' },
  });
 
  res.status(200).json({ success: true, data: { deliveries, total: deliveries.length } });
};

exports.cancelDelivery = async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  const delivery = await prisma.delivery.findUnique({ where: { id } });
  if (!delivery) throw new AppError('Delivery not found', 404);
  if (['DELIVERED', 'CANCELLED'].includes(delivery.status)) {
    throw new AppError('Cannot cancel this delivery', 400);
  }

  const updated = await prisma.delivery.update({
    where: { id },
    data:  { status: 'CANCELLED', cancelledAt: new Date(), cancellationReason: reason || 'Cancelled by admin' },
  });

  // Notify both parties
  const notifyIds = [delivery.customerId, delivery.partnerId].filter(Boolean);
  await Promise.all(notifyIds.map(userId =>
    notificationService.notify({
      userId,
      title:   'Delivery Cancelled by Admin',
      message: `Your delivery has been cancelled by an admin.${reason ? ` Reason: ${reason}` : ''}`,
      type:    'delivery_cancelled',
      data:    { deliveryId: id, reason, cancelledBy: 'admin' },
    })
  ));

  await logActivity({
    userId: req.user.id, action: 'delivery_cancelled',
    entityType: 'Delivery', entityId: id,
    details: { reason }, req,
  });

  res.status(200).json({ success: true, message: 'Delivery cancelled', data: { delivery: updated } });
};

exports.getLiveRides = async (req, res) => {
  const market = marketWhere(req.user, req.query.country);
  const rides = await prisma.ride.findMany({
    where: { status: { in: ['REQUESTED', 'ACCEPTED', 'ARRIVED', 'IN_PROGRESS'] }, ...(market ? { customer: market } : {}) },
    include: {
      customer: {
        select: { id: true, firstName: true, lastName: true, phone: true, countryCode: true },
      },
      driver: {
        select: {
          id: true, firstName: true, lastName: true, phone: true, profileImage: true,
          driverProfile: {
            select: {
              vehicleType: true, vehicleMake: true, vehicleModel: true,
              vehicleColor: true, vehiclePlate: true,
              currentLat: true, currentLng: true,
            },
          },
        },
      },
    },
    orderBy: { requestedAt: 'desc' },
  });

  res.status(200).json({ success: true, data: { rides, total: rides.length } });
};

exports.getAdminRideById = async (req, res) => {
  const { id } = req.params;

  const ride = await prisma.ride.findUnique({
    where: { id },
    include: {
      customer: {
        select: { id: true, firstName: true, lastName: true, email: true, phone: true, profileImage: true },
      },
      driver: {
        select: {
          id: true, firstName: true, lastName: true, email: true, phone: true, profileImage: true,
          driverProfile: {
            select: {
              vehicleType: true, vehicleMake: true, vehicleModel: true,
              vehicleColor: true, vehiclePlate: true, vehicleYear: true,
              rating: true, licenseNumber: true,
              currentLat: true, currentLng: true,
            },
          },
        },
      },
      payment: true,
      rating:  true,
    },
  });

  if (!ride) throw new AppError('Ride not found', 404);

  res.status(200).json({ success: true, data: { ride } });
};

exports.adminCancelRide = async (req, res) => {
  const { id }     = req.params;
  const { reason } = req.body;

  const ride = await prisma.ride.findUnique({ where: { id } });
  if (!ride) throw new AppError('Ride not found', 404);
  if (['COMPLETED', 'CANCELLED'].includes(ride.status)) {
    throw new AppError('Cannot cancel a completed or already cancelled ride', 400);
  }

  const updated = await prisma.ride.update({
    where: { id },
    data:  { status: 'CANCELLED', cancelledAt: new Date(), cancellationReason: reason || 'Cancelled by admin' },
  });

  // Notify both parties
  const notifyIds = [ride.customerId, ride.driverId].filter(Boolean);
  await Promise.all(notifyIds.map(userId =>
    notificationService.notify({
      userId,
      title:   'Ride Cancelled by Admin',
      message: `Your ride has been cancelled by an admin.${reason ? ` Reason: ${reason}` : ''}`,
      type:    'ride_cancelled',
      data:    { rideId: id, reason, cancelledBy: 'admin' },
    })
  ));

  await logActivity({
    userId:     req.user.id,
    action:     'ride_cancelled',
    entityType: 'Ride',
    entityId:   id,
    details:    { reason },
    req,
  });

  res.status(200).json({ success: true, message: 'Ride cancelled', data: { ride: updated } });
};

// ─── CREATE ADMIN / STAFF USER (SUPER_ADMIN only) ────────────────────────────

exports.createAdminUser = async (req, res) => {
  const {
    email, phone, password, firstName, lastName,
    role, adminDepartment, countryCode,
  } = req.body;
 
  // A country admin can only create accounts inside their own countries, and never a Super Admin.
  const actorMarkets = staffMarkets(req.user);
  const actorLimited = req.user.role !== 'SUPER_ADMIN';
  if (actorLimited && role === 'SUPER_ADMIN') throw new AppError('Only a Super Admin can create a Super Admin.', 403);

  // Country-limited staff: ['ML'] makes a "Mali admin". Empty/omitted = all countries.
  let coverage = [];
  if (['ADMIN', 'SUPPORT', 'MODERATOR'].includes(role) && req.body.supportCountries !== undefined) {
    if (!Array.isArray(req.body.supportCountries)) throw new AppError('supportCountries must be a list of country codes.', 400);
    coverage = [...new Set(req.body.supportCountries.map(c => String(c).trim().toUpperCase()).filter(Boolean))];
    if (coverage.length) {
      const known = await prisma.country.findMany({ where: { code: { in: coverage } }, select: { code: true } });
      const missing = coverage.filter(c => !known.some(k => k.code === c));
      if (missing.length) throw new AppError(`Unknown country code(s): ${missing.join(', ')}`, 400);
    }
  }
  if (actorLimited) {
    if (['ADMIN', 'SUPPORT', 'MODERATOR'].includes(role)) {
      if (!coverage.length) coverage = [...actorMarkets];                       // default: same countries as you
      if (coverage.some(c => !actorMarkets.includes(c))) throw new AppError('You can only assign countries that you manage yourself.', 403);
    } else if (countryCode && !actorMarkets.includes(String(countryCode).toUpperCase())) {
      throw new AppError('You can only create accounts for your own countries.', 403);
    }
  }
  const effectiveCountry = String(countryCode || coverage[0] || (actorLimited ? actorMarkets[0] : '') || 'NG').toUpperCase();

  // Only ADMIN, SUPPORT, MODERATOR can be created here (not CUSTOMER/DRIVER/etc.)
  const allowedRoles = ['SUPER_ADMIN', 'ADMIN', 'SUPPORT', 'MODERATOR', 'CUSTOMER', 'DRIVER', 'DELIVERY_PARTNER'];
if (!allowedRoles.includes(role))
  throw new AppError(`Role must be one of: ${allowedRoles.join(', ')}`, 400);
  const existing = await prisma.user.findFirst({
    where: { OR: [{ email }, { phone }] },
  });
  if (existing) throw new AppError('A user with this email or phone already exists', 400);
 
  const hashed = await bcrypt.hash(password, 10);
 
const user = await prisma.user.create({
  data: {
    email, phone, firstName, lastName,
    password:        hashed,
    role,
    countryCode:     effectiveCountry,
    supportCountries: coverage,
    adminDepartment: ['ADMIN', 'SUPPORT', 'MODERATOR', 'SUPER_ADMIN'].includes(role)
      ? (adminDepartment ?? null)
      : null,
    isVerified:      true,
    isActive:        true,
  },
  select: {
    id: true, email: true, phone: true, firstName: true, lastName: true,
    role: true, adminDepartment: true, supportCountries: true, isActive: true, createdAt: true,
  },
});

// Create wallet for all roles
await ensureWallet(user.id, effectiveCountry);

// Create role-specific profile
if (role === 'DRIVER') {
  const {
    licenseNumber, vehicleType, vehicleMake, vehicleModel,
    vehicleYear, vehicleColor, vehiclePlate,
  } = req.body;

  // Check for duplicates
  const [plateExists, licenseExists] = await Promise.all([
    prisma.driverProfile.findUnique({ where: { vehiclePlate } }),
    prisma.driverProfile.findUnique({ where: { licenseNumber } }),
  ]);
  if (plateExists)   throw new AppError('A driver with this vehicle plate already exists', 400);
  if (licenseExists) throw new AppError('A driver with this license number already exists', 400);

  // DRIVER profile — add document URLs
await prisma.driverProfile.create({
  data: {
    userId:       user.id,
    licenseNumber,
    vehicleType,
    vehicleMake,
    vehicleModel,
    vehicleYear:  parseInt(vehicleYear),
    vehicleColor,
    vehiclePlate,
    isApproved:   true,
    approvedBy:   req.user.id,
    approvedAt:   new Date(),
    // ── Document URLs (all optional) ──────────────────────
    ...(req.body.vehicleSubType        && { vehicleSubType:        req.body.vehicleSubType }),
    ...(req.body.numberOfSeats         && { numberOfSeats:         parseInt(req.body.numberOfSeats) }),
    ...(req.body.applicantPhotoUrl     && { applicantPhotoUrl:     req.body.applicantPhotoUrl }),
    ...(req.body.govtIdUrl             && { govtIdUrl:             req.body.govtIdUrl }),
    ...(req.body.proofOfAddressUrl     && { proofOfAddressUrl:     req.body.proofOfAddressUrl }),
    ...(req.body.licenseImageUrl       && { licenseImageUrl:       req.body.licenseImageUrl }),
    ...(req.body.vehicleRegUrl         && { vehicleRegUrl:         req.body.vehicleRegUrl }),
    ...(req.body.insuranceUrl          && { insuranceUrl:          req.body.insuranceUrl }),
    ...(req.body.roadWorthinessUrl     && { roadWorthinessUrl:     req.body.roadWorthinessUrl }),
    ...(req.body.vehicleInspectionUrl  && { vehicleInspectionUrl:  req.body.vehicleInspectionUrl }),
    ...(req.body.hackneyCertUrl        && { hackneyCertUrl:        req.body.hackneyCertUrl }),
    ...(req.body.vehiclePhotoExteriorUrl && { vehiclePhotoExteriorUrl: req.body.vehiclePhotoExteriorUrl }),
    ...(req.body.vehiclePhotoInteriorUrl && { vehiclePhotoInteriorUrl: req.body.vehiclePhotoInteriorUrl }),
    ...(req.body.riderCardUrl          && { riderCardUrl:          req.body.riderCardUrl }),
    ...(req.body.helmetPhotoUrl        && { helmetPhotoUrl:        req.body.helmetPhotoUrl }),
    ...(req.body.dispatchPermitUrl     && { dispatchPermitUrl:     req.body.dispatchPermitUrl }),
    ...(req.body.guarantorLetterUrl    && { guarantorLetterUrl:    req.body.guarantorLetterUrl }),
    ...(req.body.guarantorIdUrl        && { guarantorIdUrl:        req.body.guarantorIdUrl }),
    ...(req.body.operatorPermitUrl     && { operatorPermitUrl:     req.body.operatorPermitUrl }),
  },
});
}

if (role === 'DELIVERY_PARTNER') {
  const { vehicleType, vehiclePlate } = req.body;

  // DELIVERY_PARTNER profile — add document URLs
await prisma.deliveryPartnerProfile.create({
  data: {
    userId:      user.id,
    vehicleType,
    vehiclePlate: vehiclePlate || null,
    isApproved:   true,
    approvedBy:   req.user.id,
    approvedAt:   new Date(),
    // ── Document URLs (all optional) ──────────────────────
    ...(req.body.vehicleSubType        && { vehicleSubType:        req.body.vehicleSubType }),
    ...(req.body.numberOfSeats         && { numberOfSeats:         parseInt(req.body.numberOfSeats) }),
    ...(req.body.applicantPhotoUrl     && { applicantPhotoUrl:     req.body.applicantPhotoUrl }),
    ...(req.body.govtIdUrl             && { govtIdUrl:             req.body.govtIdUrl }),
    ...(req.body.proofOfAddressUrl     && { proofOfAddressUrl:     req.body.proofOfAddressUrl }),
    ...(req.body.idImageUrl            && { idImageUrl:            req.body.idImageUrl }),
    ...(req.body.vehicleImageUrl       && { vehicleImageUrl:       req.body.vehicleImageUrl }),
    ...(req.body.insuranceUrl          && { insuranceUrl:          req.body.insuranceUrl }),
    ...(req.body.roadWorthinessUrl     && { roadWorthinessUrl:     req.body.roadWorthinessUrl }),
    ...(req.body.vehiclePhotoExteriorUrl && { vehiclePhotoExteriorUrl: req.body.vehiclePhotoExteriorUrl }),
    ...(req.body.vehiclePhotoInteriorUrl && { vehiclePhotoInteriorUrl: req.body.vehiclePhotoInteriorUrl }),
    ...(req.body.riderCardUrl          && { riderCardUrl:          req.body.riderCardUrl }),
    ...(req.body.helmetPhotoUrl        && { helmetPhotoUrl:        req.body.helmetPhotoUrl }),
    ...(req.body.dispatchPermitUrl     && { dispatchPermitUrl:     req.body.dispatchPermitUrl }),
    ...(req.body.guarantorLetterUrl    && { guarantorLetterUrl:    req.body.guarantorLetterUrl }),
    ...(req.body.guarantorIdUrl        && { guarantorIdUrl:        req.body.guarantorIdUrl }),
    ...(req.body.operatorPermitUrl     && { operatorPermitUrl:     req.body.operatorPermitUrl }),
  },
});
}

  // ── Email notification — every admin-created account gets one, tailored
  // to role. Non-fatal: the account is already created either way. ────────
  if (user.email) {
    if (role === 'DRIVER') {
      await safeSendEmail(
        () => emailService.sendDriverApprovedEmail(user.email, user.firstName, {
          source: 'admin_created',
          password,
        }),
        `Admin-created driver account (${user.id})`
      );
    } else if (role === 'DELIVERY_PARTNER') {
      await safeSendEmail(
        () => emailService.sendPartnerApprovedEmail(user.email, user.firstName, {
          source: 'admin_created',
          password,
        }),
        `Admin-created partner account (${user.id})`
      );
    } else {
      await safeSendEmail(
        () => emailService.sendAdminCreatedAccountEmail(user.email, user.firstName, {
          role,
          password,
        }),
        `Admin-created ${role} account (${user.id})`
      );
    }
  }
 
  await logActivity({
    userId: req.user.id,
    action: 'admin_user_created',
    entityType: 'User',
    entityId: user.id,
    details: {
    role,
    adminDepartment,
    createdEmail: email,
    ...(role === 'DRIVER'            && { vehiclePlate: req.body.vehiclePlate }),
    ...(role === 'DELIVERY_PARTNER'  && { vehiclePlate: req.body.vehiclePlate }),
  },
    req,
  });
 
  res.status(201).json({
    success: true,
    message: `${role} account created successfully${adminDepartment ? ` with ${adminDepartment} department access` : ''}`,
    data: { user },
  });
};

// ─────────────────────────────────────────────
// SUPPORT TICKETS
// ─────────────────────────────────────────────

exports.getTickets = async (req, res) => {
  const { page = 1, limit = 20, status, priority, assignedTo, category, countryCode, language, search } = req.query;
  const pageN  = Math.max(parseInt(page, 10) || 1, 1);
  const limitN = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);

  // Agents only see the markets/languages they are assigned to.
  const scope = ticketScopeWhere(req.user);
  const where = { ...scope };
  // An explicit filter may only NARROW what the agent may already see.
  const narrow = (allowed, wanted) => (allowed ? { in: allowed.in.includes(wanted) ? [wanted] : [] } : wanted);
  if (countryCode) where.countryCode = narrow(scope.countryCode, String(countryCode).toUpperCase());
  if (language)    where.language    = narrow(scope.language,    String(language).toLowerCase());

  if (status)     where.status = status;
  if (priority)   where.priority = priority;
  if (category)   where.category = category;
  if (assignedTo) where.assignedTo = assignedTo;
  if (search && String(search).trim()) {
    const q = String(search).trim();
    where.OR = [
      { ticketNumber: { contains: q, mode: 'insensitive' } },
      { subject:      { contains: q, mode: 'insensitive' } },
    ];
  }

  const [tickets, total, openRows] = await Promise.all([
    prisma.supportTicket.findMany({
      where, skip: (pageN - 1) * limitN, take: limitN, orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, firstName: true, lastName: true, role: true, email: true, phone: true } } },
    }),
    prisma.supportTicket.count({ where }),
    prisma.supportTicket.groupBy({
      by: ['countryCode'],
      where: { ...scope, status: { in: ['open', 'in_progress'] } },
      _count: { _all: true },
    }),
  ]);

  const openByCountry = Object.fromEntries(openRows.map(r => [r.countryCode, r._count._all]));
  res.status(200).json({
    success: true,
    data: { tickets, openByCountry, pagination: { total, page: pageN, pages: Math.ceil(total / limitN) } },
  });
};

exports.getTicketById = async (req, res) => {
  const { id } = req.params;
 
  const ticket = await prisma.supportTicket.findUnique({
    where: { id },
    include: {
      user: {
        select: { id: true, firstName: true, lastName: true, email: true, phone: true, role: true },
      },
      replies: {
        orderBy: { createdAt: 'asc' },
        include: {
          author: {
            select: { id: true, firstName: true, lastName: true, role: true },
          },
        },
      },
    },
  });
 
  if (!ticket) throw new AppError('Ticket not found', 404);
  if (!canAccessTicket(req.user, ticket)) throw new AppError('This ticket belongs to a market or language you are not assigned to.', 403);
 
  res.status(200).json({ success: true, data: { ticket } });
};

// ─── STAFF SUPPORT COVERAGE ──────────────────────────────────────────────────
// Which countries / languages a support agent handles. Empty list = everything.
exports.updateStaffSupportCoverage = async (req, res) => {
  const { id } = req.params;
  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, supportCountries: true } });
  if (!target) throw new AppError('User not found', 404);
  if (!['ADMIN', 'SUPER_ADMIN', 'SUPPORT', 'MODERATOR'].includes(target.role))
    throw new AppError('Support coverage only applies to staff accounts.', 400);
  const actorIsSuper = req.user.role === 'SUPER_ADMIN';
  if (!actorIsSuper) {
    if (id === req.user.id) throw new AppError('You cannot change your own country assignment.', 403);
    if (!staffInsideMarkets(req.user, target)) throw new AppError('You can only manage staff who belong to your own countries.', 403);
  }

  // Normalise FIRST, then de-duplicate ('ml' and 'ML' collapse to one).
  const list = (v, label, norm) => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v)) throw new AppError(`${label} must be a list`, 400);
    return [...new Set(v.map(x => norm(String(x).trim())).filter(Boolean))];
  };
  const countries = list(req.body.supportCountries, 'supportCountries', c => c.toUpperCase());
  const languages = list(req.body.supportLanguages, 'supportLanguages', l => l.toLowerCase());
  if (!actorIsSuper && countries !== undefined) {
    const mine = staffMarkets(req.user);
    if (!countries.length || countries.some(c => !mine.includes(c)))
      throw new AppError('Choose one or more of your own countries (an empty list would give all-country access).', 403);
  }

  if (countries?.length) {
    const known = new Set((await prisma.country.findMany({ select: { code: true } })).map(c => c.code));
    const unknown = countries.filter(c => !known.has(c));
    if (unknown.length) throw new AppError(`Unknown country code(s): ${unknown.join(', ')}`, 400);
  }
  if (languages?.length) {
    const unknown = languages.filter(l => !SUPPORTED_LANGUAGES.includes(l));
    if (unknown.length) throw new AppError(`Unsupported language(s): ${unknown.join(', ')}`, 400);
  }

  const data = {};
  if (countries !== undefined) data.supportCountries = countries;
  if (languages !== undefined) data.supportLanguages = languages;
  if (!Object.keys(data).length) throw new AppError('Nothing to update', 400);

  const user = await prisma.user.update({ where: { id }, data, select: { id: true, supportCountries: true, supportLanguages: true } });

  await logActivity({
    userId: req.user.id, action: 'staff_support_coverage_updated', entityType: 'User', entityId: id,
    details: { supportCountries: user.supportCountries, supportLanguages: user.supportLanguages }, req,
  });

  res.status(200).json({ success: true, message: 'Support coverage updated', data: { user } });
};

// ─── UPDATE TICKET (with reply support) ──────────────────────────────────────
exports.updateTicket = async (req, res) => {
  const { id } = req.params;
  const { status, assignedTo, resolution, replyMessage } = req.body;

  const ticket = await prisma.supportTicket.findUnique({
    where: { id },
    include: { user: { select: { id: true, firstName: true, email: true } } },
  });
  if (!ticket) throw new AppError('Ticket not found', 404);
  if (!canAccessTicket(req.user, ticket)) throw new AppError('This ticket belongs to a market or language you are not assigned to.', 403);

  // Everything WE say to the customer is in the language they opened the ticket in.
  const lang = normalizeLanguage(ticket.language);

  const updated = await prisma.supportTicket.update({
    where: { id },
    data: {
      ...(status      && { status }),
      ...(assignedTo  && { assignedTo }),
      ...(resolution  && { resolution }),
      ...(status === 'resolved' && { resolvedAt: new Date() }),
    },
  });

  if (replyMessage?.trim()) {
    try {
      await prisma.ticketReply.create({
        data: {
          ticketId: id,
          authorId: req.user.id,
          message:  replyMessage.trim(),
          isAdmin:  true,
        },
      });
    } catch {
      // TicketReply model may not exist yet — skip gracefully
    }

    await notificationService.notify({
      userId:  ticket.userId,
      title:   tr(lang, 'replyTitle', { n: ticket.ticketNumber }),
      message: replyMessage.trim(),
      type:    'ticket_reply',
      data:    { ticketId: id, ticketNumber: ticket.ticketNumber, repliedBy: req.user.id },
    });

    if (ticket.user?.email) {
      await safeSendEmail(
        () => emailService.sendTicketReplyEmail(ticket.user.email, ticket.user.firstName, {
          ticketNumber: ticket.ticketNumber,
          message: replyMessage.trim(),
          language: lang,
        }),
        'Ticket reply'
      );
    }
  }

  if (status === 'resolved') {
    await notificationService.notify({
      userId:  ticket.userId,
      title:   tr(lang, 'resolvedTitle', { n: ticket.ticketNumber }),
      message: `${tr(lang, 'resolvedBody')}${resolution ? ` ${tr(lang, 'resolutionLabel')}: ${resolution}` : ''}`,
      type:    'ticket_resolved',
      data:    { ticketId: id, ticketNumber: ticket.ticketNumber },
    });

    if (ticket.user?.email) {
      await safeSendEmail(
        () => emailService.sendTicketResolvedEmail(ticket.user.email, ticket.user.firstName, {
          ticketNumber: ticket.ticketNumber,
          resolution: resolution || '',
          language: lang,
        }),
        'Ticket resolved'
      );
    }
  }

  await logActivity({
    userId: req.user.id,
    action: 'ticket_updated',
    entityType: 'SupportTicket',
    entityId: id,
    details: { status, assignedTo, hasReply: !!replyMessage },
    req,
  });

  res.status(200).json({ success: true, message: 'Ticket updated', data: { ticket: updated } });
};

exports.getAppFeedback = async (req, res) => {
  const { page = 1, limit = 20, rating, category, country } = req.query;
  const skip  = (parseInt(page) - 1) * parseInt(limit);
  const fMarket = marketWhere(req.user, country);
  const where = fMarket ? { user: fMarket } : {};
  if (rating)   where.rating   = parseInt(rating);
  if (category) where.category = category;
 
  const [feedback, total] = await Promise.all([
    prisma.appFeedback.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit),
      include: {
        user: {
          select: { id: true, firstName: true, lastName: true, email: true, role: true },
        },
      },
    }),
    prisma.appFeedback.count({ where }),
  ]);
 
  res.status(200).json({
    success: true,
    data: {
      feedback,
      pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) },
    },
  });
};
 
exports.getAppFeedbackStats = async (req, res) => {
  const fm = marketWhere(req.user, req.query.country);
  const fw = fm ? { user: fm } : {};
  const [total, ratingGroups, categoryGroups, avgResult] = await Promise.all([
    prisma.appFeedback.count({ where: fw }),
    prisma.appFeedback.groupBy({ by: ['rating'],   where: fw, _count: { rating: true }   }),
    prisma.appFeedback.groupBy({ by: ['category'], where: fw, _count: { category: true } }),
    prisma.appFeedback.aggregate({ where: fw, _avg: { rating: true } }),
  ]);
 
  const distribution = {};
  ratingGroups.forEach(r => { distribution[String(r.rating)] = r._count.rating; });
 
  const byCategory = {};
  categoryGroups.forEach(c => { byCategory[c.category] = c._count.category; });
 
  res.status(200).json({
    success: true,
    data: {
      total,
      averageRating: avgResult._avg.rating ?? 0,
      distribution,
      byCategory,
    },
  });
};

module.exports = exports;