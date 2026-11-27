require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
p.$queryRawUnsafe('select 1 as ok')
  .then(r => { console.log('CONNECTED', r); process.exit(0); })
  .catch(e => { console.log(e.message); process.exit(1); });
