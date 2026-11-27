require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const u = new URL(process.env.DIRECT_URL);
u.hostname = 'db.cjutjqnonlblxypmeoau.supabase.co'; u.username = 'postgres'; u.search = '';
new PrismaClient({ datasourceUrl: u.toString() }).$queryRawUnsafe('select 1')
  .then(() => { console.log('OK direct host'); process.exit(0); })
  .catch(e => { console.log('FAIL', e.message.split('\n').filter(Boolean).pop().slice(0, 120)); process.exit(1); });
