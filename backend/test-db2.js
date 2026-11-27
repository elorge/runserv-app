require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const u = new URL(process.env.DIRECT_URL);
const mk = (port, params) => { const x = new URL(u); x.port = port; x.search = params; return x.toString(); };
const tests = {
  'A 5432 no params': mk('5432', ''),
  'B 5432 sslmode=require': mk('5432', '?sslmode=require'),
  'C 6543 pgbouncer': mk('6543', '?pgbouncer=true&connection_limit=1'),
  'D 5432 sslmode=disable': mk('5432', '?sslmode=disable'),
};
(async () => {
  for (const [name, url] of Object.entries(tests)) {
    const p = new PrismaClient({ datasourceUrl: url });
    try { await p.$queryRawUnsafe('select 1'); console.log('OK     ', name); }
    catch (e) { console.log('FAIL   ', name, '->', e.message.split('\n').filter(Boolean).pop().slice(0, 110)); }
    await p.$disconnect();
  }
})();
