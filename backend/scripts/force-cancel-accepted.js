// backend/scripts/force-cancel-accepted.js
//
// DEVELOPMENT / TEST ONLY. Cancels an explicit list of test rides.
//
// Safety model (P0 fix, see Launch Readiness Guide §3.1):
//   * Refuses unless NODE_ENV is "development" or "test".
//   * Refuses unless ALLOW_DESTRUCTIVE_SCRIPTS=I_UNDERSTAND is set AND the
//     database name contains "dev", "test" or "local" AND the database HOST is local
//     (localhost/127.0.0.1/::1) or explicitly listed in DESTRUCTIVE_SCRIPT_ALLOWED_HOSTS.
//   * Requires explicit ride IDs; it never queries "all active rides".
//   * DRY-RUN by default. Nothing changes unless --confirm is passed.
//   * Never touches driver online state. Optionally pass --drivers=<id,id>
//     to set ONLY those named test drivers offline.
//
// Usage:
//   node scripts/force-cancel-accepted.js --rides=<id1,id2>             (dry run)
//   node scripts/force-cancel-accepted.js --rides=<id1,id2> --confirm   (applies)
//   node scripts/force-cancel-accepted.js --rides=<id> --drivers=<id> --confirm

const ACTIVE = ['REQUESTED', 'ACCEPTED', 'ARRIVED', 'IN_PROGRESS'];

function parseArgs(argv) {
  const out = { rides: [], drivers: [], confirm: false };
  for (const a of argv) {
    if (a === '--confirm') out.confirm = true;
    else if (a.startsWith('--rides=')) out.rides = splitIds(a.slice(8));
    else if (a.startsWith('--drivers=')) out.drivers = splitIds(a.slice(10));
  }
  return out;
}

function splitIds(s) {
  return String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
}

// M12: a database NAME proves nothing (a production host can have a database called "dev"). The HOST must be local, or be
// listed explicitly in DESTRUCTIVE_SCRIPT_ALLOWED_HOSTS (comma-separated) by someone who knows it is disposable.
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal'];

function dbHost(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function dbName(url) {
  try {
    return new URL(url).pathname.replace(/^\//, '').split('?')[0];
  } catch {
    return '';
  }
}

/**
 * Pure guard — exported so tests can prove staging/production are rejected.
 * Returns { ok: true } or { ok: false, reason }.
 */
function checkEnvironment(env = process.env) {
  const nodeEnv = String(env.NODE_ENV || '').toLowerCase();
  if (nodeEnv !== 'development' && nodeEnv !== 'test') {
    return { ok: false, reason: `NODE_ENV must be "development" or "test" (got "${nodeEnv || 'unset'}").` };
  }
  if (env.ALLOW_DESTRUCTIVE_SCRIPTS !== 'I_UNDERSTAND') {
    return { ok: false, reason: 'Set ALLOW_DESTRUCTIVE_SCRIPTS=I_UNDERSTAND to acknowledge this is a destructive script.' };
  }
  const name = dbName(env.DATABASE_URL || '').toLowerCase();
  if (!name || !/(dev|test|local)/.test(name)) {
    return { ok: false, reason: `DATABASE_URL database name "${name || 'unknown'}" is not clearly disposable (must contain dev, test or local).` };
  }
  const host = dbHost(env.DATABASE_URL || '');
  const allowed = [...LOCAL_HOSTS, ...String(env.DESTRUCTIVE_SCRIPT_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)];
  if (!host || !allowed.includes(host)) {
    return { ok: false, reason: `Database host "${host || 'unknown'}" is not a local host. Add it to DESTRUCTIVE_SCRIPT_ALLOWED_HOSTS only if it is certainly a disposable database.` };
  }
  if (/(prod|staging|live)/.test(name)) {
    return { ok: false, reason: `Database name "${name}" looks like staging/production.` };
  }
  return { ok: true };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const guard = checkEnvironment(env);
  if (!guard.ok) {
    console.error(`REFUSED: ${guard.reason}`);
    process.exitCode = 1;
    return { refused: true, reason: guard.reason };
  }

  const args = parseArgs(argv);
  if (!args.rides.length) {
    console.error('REFUSED: pass explicit ride IDs with --rides=<id1,id2>. This script never cancels "all active rides".');
    process.exitCode = 1;
    return { refused: true, reason: 'no ride ids' };
  }

  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const rides = await prisma.ride.findMany({
      where: { id: { in: args.rides }, status: { in: ACTIVE } },
      select: { id: true, status: true, customerId: true, driverId: true },
    });
    console.log(`\n${args.confirm ? 'APPLYING' : 'DRY RUN'} — ${rides.length} of ${args.rides.length} named ride(s) are active:\n`);
    rides.forEach((r) => console.log(`  ${r.id}  ${r.status}`));
    const missing = args.rides.filter((id) => !rides.some((r) => r.id === id));
    if (missing.length) console.log(`\n  Not active / not found (ignored): ${missing.join(', ')}`);

    if (!args.confirm) {
      console.log('\nDry run only. Re-run with --confirm to apply.\n');
      return { dryRun: true, wouldCancel: rides.length };
    }
    if (!rides.length) return { cancelled: 0 };

    const { count } = await prisma.ride.updateMany({
      where: { id: { in: rides.map((r) => r.id) }, status: { in: ACTIVE } },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancellationReason: 'Dev reset (scripted)' },
    });
    let drivers = 0;
    if (args.drivers.length) {
      const res = await prisma.driverProfile.updateMany({
        where: { userId: { in: args.drivers }, isOnline: true },
        data: { isOnline: false },
      });
      drivers = res.count;
    }
    console.log(`\nCancelled ${count} ride(s). Set ${drivers} named driver(s) offline.\n`);
    return { cancelled: count, driversOffline: drivers };
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}

module.exports = { checkEnvironment, parseArgs, main };
