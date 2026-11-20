// backend/prisma/reset-admin-passwords.js

'use strict';
// Development helper: resets the seeded dev admins to a KNOWN password. It must never run against a production database.
if (require('../src/utils/envGuard').isProduction()) {
  console.error('Refusing to reset admin passwords to a known default in production. Use the admin console (or the forgot-password flow) instead.');
  process.exit(1);
}
const { PrismaClient } = require('@prisma/client');
const bcrypt           = require('bcryptjs');
const prisma           = new PrismaClient();

const ADMINS = [
  { email: 'superadmin@runserv.org', password: 'Runserv1@' },
  { email: 'admin@runserv.org',      password: 'Runserv1@' },
  { email: 'rides@runserv.org',      password: 'Runserv1@' },
  { email: 'deliveries@runserv.org', password: 'Runserv1@' },
  { email: 'support@runserv.org',    password: 'Runserv1@' },
];

async function main() {
  for (const admin of ADMINS) {
    const hashed = await bcrypt.hash(admin.password, 10);
    const user = await prisma.user.update({
      where:  { email: admin.email },
      data:   { password: hashed },
    });
    console.log(`✅  Password reset — ${user.email}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());