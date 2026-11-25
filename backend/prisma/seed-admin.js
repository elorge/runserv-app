// backend/prisma/seed-admins.js
//
// PREREQUISITE — add adminDepartment to prisma/schema.prisma User model:
//   adminDepartment  String?   // 'RIDES' | 'DELIVERIES' | 'SUPPORT' | null
// Then: npx prisma migrate dev --name add_admin_department && npx prisma generate

'use strict';
const { PrismaClient } = require('@prisma/client');
const bcrypt           = require('bcryptjs');
const prisma           = new PrismaClient();

const ADMINS = [
  {
    email: 'superadmin@runserv.org', password: 'Runserv1@',
    firstName: 'Super', lastName: 'Admin', phone: '+2348000000001',
    role: 'SUPER_ADMIN', adminDepartment: null,
  },
  {
    email: 'admin@runserv.org', password: 'Runserv1@',
    firstName: 'General', lastName: 'Admin', phone: '+2348000000002',
    role: 'ADMIN', adminDepartment: null,         // full admin — all sections
  },
  {
    email: 'rides@runserv.org', password: 'Runserv1@',
    firstName: 'Rides', lastName: 'Admin', phone: '+2348000000003',
    role: 'ADMIN', adminDepartment: 'RIDES',       // drivers + rides only
  },
  {
    email: 'deliveries@runserv.org', password: 'Runserv1@',
    firstName: 'Deliveries', lastName: 'Admin', phone: '+2348000000004',
    role: 'ADMIN', adminDepartment: 'DELIVERIES',  // partners + deliveries only
  },
  {
    email: 'support@runserv.org', password: 'Runserv1@',
    firstName: 'Support', lastName: 'Agent', phone: '+2348000000005',
    role: 'SUPPORT', adminDepartment: 'SUPPORT',   // tickets + read-only users
  },
];

// ── PRODUCTION SAFETY ────────────────────────────────────────────────────────
// The accounts above use a KNOWN password and exist for development only. In production this script creates exactly ONE
// SUPER_ADMIN from environment variables you supply (never a default password):
//   SEED_ADMIN_EMAIL=you@yourcompany.com SEED_ADMIN_PASSWORD='<12+ chars>' SEED_ADMIN_PHONE=+234... node prisma/seed-admin.js
// Then sign in, enrol MFA, create the real staff from the admin console, and remove the seed variables.
const { isProduction } = require('../src/utils/envGuard');
const KNOWN_PASSWORDS = ['Runserv1@', 'happen123', 'Test1234!'];
let accounts = ADMINS;
if (!isProduction()) {
  // Development accounts have a KNOWN password. Refuse unless explicitly allowed AND the database is local.
  const host = (() => { try { return new URL(process.env.DATABASE_URL || '').hostname; } catch { return ''; } })();
  const local = ['localhost', '127.0.0.1', '::1', ''].includes(host);
  if (process.env.ALLOW_DEV_SEED !== 'yes') { console.error('Refusing to create development admins (known password). Set ALLOW_DEV_SEED=yes to confirm this is a throw-away LOCAL database.'); process.exit(1); }
  if (!local) { console.error(`Refusing: DATABASE_URL host "${host}" is not local. Development admins (known password) must never be created on a shared database.`); process.exit(1); }
}
if (isProduction()) {
  const email = process.env.SEED_ADMIN_EMAIL; const password = process.env.SEED_ADMIN_PASSWORD; const phone = process.env.SEED_ADMIN_PHONE;
  const problems = [];
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) problems.push('SEED_ADMIN_EMAIL must be a real email address');
  if (!phone || !/^\+\d{8,15}$/.test(phone)) problems.push('SEED_ADMIN_PHONE must be an international number such as +2348012345678');
  if (!password || password.length < 12 || KNOWN_PASSWORDS.includes(password)) problems.push('SEED_ADMIN_PASSWORD must be 12+ characters and not a known default');
  if (problems.length) { console.error('Refusing to seed in production:\n - ' + problems.join('\n - ')); process.exit(1); }
  accounts = [{ email, password, phone, firstName: 'Super', lastName: 'Admin', role: 'SUPER_ADMIN', adminDepartment: null }];
  console.log('Production mode: creating ONE super admin from SEED_ADMIN_* (the development accounts are skipped).');
}

async function main() {
  for (const admin of accounts) {
    const hashed = await bcrypt.hash(admin.password, 10);
    const user = await prisma.user.upsert({
      where:  { email: admin.email },
      update: { adminDepartment: admin.adminDepartment },
      create: {
        email: admin.email, phone: admin.phone, password: hashed,
        firstName: admin.firstName, lastName: admin.lastName,
        role: admin.role, isVerified: true, isActive: true,
        adminDepartment: admin.adminDepartment,
      },
    });
    await prisma.wallet.upsert({
      where: { userId: user.id }, update: {},
      create: { userId: user.id, balance: 0, currency: 'NGN' },
    });
    console.log(`✅  ${admin.role}${admin.adminDepartment ? ` [${admin.adminDepartment}]` : ''} — ${admin.email}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());