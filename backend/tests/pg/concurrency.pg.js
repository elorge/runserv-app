'use strict';
// Real-PostgreSQL concurrency proof for the M16.2.1 atomic operations.   RUNSERV_PG_URL=... node tests/pg/concurrency.pg.js
// Run it against a SCRATCH database already migrated by scripts/rehearse-migrations.sh. It is not part of `jest` (it needs a live database).
//
// WHAT THIS PROVES AND WHAT IT DOES NOT: each statement below is the SQL shape Prisma emits for the corresponding updateMany in the service
// (a single UPDATE ... WHERE <state guard>, run under PostgreSQL's default READ COMMITTED isolation, where a blocked UPDATE re-evaluates its WHERE
// clause after the first one commits). It proves the DATABASE semantics the code relies on. It does NOT run the Prisma client (the engine could not
// be downloaded where this was developed): repeat it through the real app in staging (docs/M16_2_1_VALIDATION.md, gate G9).
const { Pool } = require('pg');
const assert = require('assert');
const crypto = require('crypto');
const url = process.env.RUNSERV_PG_URL; if (!url) { console.error('Set RUNSERV_PG_URL to a scratch database.'); process.exit(2); }
const pool = new Pool({ connectionString: url, max: 40 });
const uid = () => crypto.randomUUID();
const results = [];
const check = async (name, fn) => { try { await fn(); results.push([name, 'PASS']); console.log(`PASS  ${name}`); } catch (e) { results.push([name, 'FAIL']); console.error(`FAIL  ${name}\n      ${e.message}`); } };

const seed = async (over = {}) => {
  const id = uid(); const hash = crypto.randomBytes(16).toString('hex');
  await pool.query(`INSERT INTO "Delivery"("id","status","podCodeHash","podCodeAttempts","partnerId","podCodeVersion") VALUES ($1,$2,$3,0,'courier-1',1)`, [id, over.status || 'IN_TRANSIT', hash]);
  return { id, hash };
};
const COOLDOWN_MS = 120000;

async function reserveTx(d, now, withEmail) {            // = deliveryComms.reserve(): conditional UPDATE, then the outbox row, in one transaction
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query(`UPDATE "Delivery" SET "podNotifyReservedAt"=$3 WHERE "id"=$1 AND "podCodeHash"=$2 AND "podVerifiedAt" IS NULL AND "failedAt" IS NULL AND "status"<>'CANCELLED' AND ("podNotifyReservedAt" IS NULL OR "podNotifyReservedAt" <= $4)`, [d.id, d.hash, new Date(now), new Date(now - COOLDOWN_MS)]);
    if (r.rowCount !== 1) { await c.query('ROLLBACK'); return false; }
    if (withEmail) await c.query(`INSERT INTO "EmailOutbox"("kind","bookingId","toEmail","toMasked") VALUES ('RECIPIENT_CODE',$1,'a@b.co','a***@b.co')`, [d.id]);
    await c.query('COMMIT'); return true;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

(async () => {
  await check('P1.2 atomic resend: 25 simultaneous admin requests -> exactly ONE wins, exactly ONE email row, cooldown then holds', async () => {
    const d = await seed(); const now = Date.now();
    const out = await Promise.all(Array.from({ length: 25 }, () => reserveTx(d, now, true)));
    assert.strictEqual(out.filter(Boolean).length, 1, `winners=${out.filter(Boolean).length}`);
    const rows = (await pool.query(`SELECT count(*)::int n FROM "EmailOutbox" WHERE "bookingId"=$1`, [d.id])).rows[0].n; assert.strictEqual(rows, 1, `email rows=${rows}`);
    assert.strictEqual(await reserveTx(d, now + 1000, true), false, 'a request 1 s later must still be inside the cooldown');
    assert.strictEqual(await reserveTx(d, now + COOLDOWN_MS + 1000, true), true, 'after the cooldown a new resend wins');
  });
  await check('P1.2 repeated rounds (40 x 10 concurrent) never produce two winners', async () => {
    for (let i = 0; i < 40; i += 1) { const d = await seed(); const w = (await Promise.all(Array.from({ length: 10 }, () => reserveTx(d, Date.now(), false)))).filter(Boolean).length; assert.strictEqual(w, 1, `round ${i}: winners=${w}`); }
  });
  await check('P1.1 concurrent rotations: the compare-and-swap on the old hash lets exactly ONE through; version moves once', async () => {
    const d = await seed(); const old = d.hash;
    const rot = () => pool.query(`UPDATE "Delivery" SET "podCodeHash"=$3,"podCodeNonce"=$4,"podCodeVersion"=2,"podCodeRotatedAt"=now(),"podCodeAttempts"=0 WHERE "id"=$1 AND "podCodeHash"=$2 AND "podVerifiedAt" IS NULL AND "failedAt" IS NULL`, [d.id, old, crypto.randomBytes(16).toString('hex'), crypto.randomBytes(16).toString('hex')]).then((r) => r.rowCount);
    const wins = (await Promise.all(Array.from({ length: 25 }, rot))).reduce((a, b) => a + b, 0); assert.strictEqual(wins, 1, `rotations that won=${wins}`);
    assert.strictEqual((await pool.query(`SELECT "podCodeVersion" v FROM "Delivery" WHERE id=$1`, [d.id])).rows[0].v, 2);
  });
  await check('P1.1 rotation vs verification (60 races): never both succeed, and the OLD code never completes after a rotation committed', async () => {
    for (let i = 0; i < 60; i += 1) {
      const d = await seed(); const fresh = crypto.randomBytes(16).toString('hex');
      const rot = pool.query(`UPDATE "Delivery" SET "podCodeHash"=$3,"podCodeVersion"=2 WHERE "id"=$1 AND "podCodeHash"=$2 AND "podVerifiedAt" IS NULL AND "failedAt" IS NULL`, [d.id, d.hash, fresh]).then((r) => r.rowCount);
      const ver = pool.query(`UPDATE "Delivery" SET "podVerifiedAt"=now(),"podMethod"='CODE' WHERE "id"=$1 AND "partnerId"='courier-1' AND "status"='IN_TRANSIT' AND "podVerifiedAt" IS NULL AND "failedAt" IS NULL AND "podCodeHash"=$2 AND ("podCodeExpiresAt" IS NULL OR "podCodeExpiresAt" > now())`, [d.id, d.hash]).then((r) => r.rowCount);
      const [r, v] = await Promise.all([rot, ver]);
      assert.ok(!(r === 1 && v === 1), `race ${i}: both the rotation and the old-code verification succeeded`);
      if (r === 1) assert.strictEqual((await pool.query(`SELECT "podVerifiedAt" FROM "Delivery" WHERE id=$1`, [d.id])).rows[0].podVerifiedAt, null);
    }
  });
  await check('POD attempt cap: 80 parallel wrong guesses -> exactly 5 attempts spent, never more', async () => {
    const d = await seed();
    const gate = () => pool.query(`UPDATE "Delivery" SET "podCodeAttempts"="podCodeAttempts"+1 WHERE "id"=$1 AND "partnerId"='courier-1' AND "status"='IN_TRANSIT' AND "podVerifiedAt" IS NULL AND "failedAt" IS NULL AND "podCodeAttempts"<5`, [d.id]).then((r) => r.rowCount);
    const spent = (await Promise.all(Array.from({ length: 80 }, gate))).reduce((a, b) => a + b, 0); assert.strictEqual(spent, 5, `attempts spent=${spent}`);
    assert.strictEqual((await pool.query(`SELECT "podCodeAttempts" n FROM "Delivery" WHERE id=$1`, [d.id])).rows[0].n, 5);
  });
  await check('two simultaneous VALID verifications complete the delivery exactly once', async () => {
    const d = await seed();
    const ver = () => pool.query(`UPDATE "Delivery" SET "podVerifiedAt"=now(),"podMethod"='CODE' WHERE "id"=$1 AND "partnerId"='courier-1' AND "status"='IN_TRANSIT' AND "podVerifiedAt" IS NULL AND "failedAt" IS NULL AND "podCodeHash"=$2`, [d.id, d.hash]).then((r) => r.rowCount);
    assert.strictEqual((await Promise.all(Array.from({ length: 20 }, ver))).reduce((a, b) => a + b, 0), 1);
  });
  await check('another courier / a cancelled or failed delivery can never be verified or spend attempts', async () => {
    const d = await seed(); const other = await pool.query(`UPDATE "Delivery" SET "podCodeAttempts"="podCodeAttempts"+1 WHERE "id"=$1 AND "partnerId"='intruder' AND "status"='IN_TRANSIT' AND "podCodeAttempts"<5`, [d.id]); assert.strictEqual(other.rowCount, 0);
    const c = await seed({ status: 'CANCELLED' }); const r = await pool.query(`UPDATE "Delivery" SET "podVerifiedAt"=now() WHERE "id"=$1 AND "status"='IN_TRANSIT' AND "podCodeHash"=$2`, [c.id, c.hash]); assert.strictEqual(r.rowCount, 0);
  });
  await check('outbox claim: 25 workers race for one PENDING row -> exactly ONE claims it', async () => {
    const id = uid(); await pool.query(`INSERT INTO "EmailOutbox"("id","kind","bookingId","toEmail","toMasked","status","nextAttemptAt") VALUES ($1,'RECIPIENT_CODE',$2,'a@b.co','a***@b.co','PENDING', now() - interval '1 second')`, [id, uid()]);
    const claim = () => pool.query(`UPDATE "EmailOutbox" SET "status"='PROCESSING',"attempts"="attempts"+1,"updatedAt"=now() WHERE "id"=$1 AND ("status"='PENDING' AND "nextAttemptAt"<=now())`, [id]).then((r) => r.rowCount);
    assert.strictEqual((await Promise.all(Array.from({ length: 25 }, claim))).reduce((a, b) => a + b, 0), 1);
  });
  await pool.end();
  const failed = results.filter(([, s]) => s === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} passed against ${(await Promise.resolve(url)).replace(/:[^:@/]*@/, ':***@')}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
