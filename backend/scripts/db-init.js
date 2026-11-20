#!/usr/bin/env node
// scripts/db-init.js — one command to create EVERY table in a fresh database (Supabase) from the Prisma schema.
//
//   pnpm db:init
//
// What it does, in order:
//   1. refuses to run unless DATABASE_URL and DIRECT_URL are set and CONFIRM_EMPTY_DB=yes (it is for an EMPTY database);
//   2. refuses if prisma/migrations already exists (use `pnpm db:deploy` for later changes);
//   3. `prisma migrate dev --create-only --name init`  → writes the SQL for every model, applies nothing yet;
//   4. appends prisma/sql/post_migrate.sql (partial indexes, CHECKs, append-only ledger, row-level security);
//   5. `prisma migrate deploy` → applies it, then `prisma generate`.
// Read the generated prisma/migrations/*_init/migration.sql before step 5 if you want to: set PAUSE_BEFORE_APPLY=yes.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const run = (args) => { const r = spawnSync('npx', ['prisma', ...args], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' }); if (r.status !== 0) { console.error(`\n✖ prisma ${args.join(' ')} failed.`); process.exit(r.status || 1); } };
const fail = (m) => { console.error(`\n✖ ${m}\n`); process.exit(1); };

try { require('dotenv').config({ path: path.join(root, '.env') }); } catch { /* dotenv optional */ }
if (!process.env.DATABASE_URL || !process.env.DIRECT_URL) fail('Set DATABASE_URL (pooled, port 6543, ?pgbouncer=true&connection_limit=1) and DIRECT_URL (direct, port 5432) in backend/.env first.');
if (/:6543\//.test(process.env.DIRECT_URL)) fail('DIRECT_URL must be the DIRECT connection (port 5432), not the pooler (6543). Migrations cannot run through the pooler.');
if (process.env.CONFIRM_EMPTY_DB !== 'yes') fail('This creates all tables and is meant for an EMPTY database. Re-run with CONFIRM_EMPTY_DB=yes to confirm.');
const migDir = path.join(root, 'prisma', 'migrations');
if (fs.existsSync(migDir) && fs.readdirSync(migDir).length) fail('prisma/migrations already exists. For later schema changes use: pnpm db:migrate --name what_changed  (never db:init again).');

console.log('1/4  Writing the migration for every model (nothing applied yet)…');
run(['migrate', 'dev', '--create-only', '--name', 'init']);

const dir = fs.readdirSync(migDir).filter((d) => d.endsWith('_init')).sort().pop();
if (!dir) fail('Could not find the generated init migration.');
const file = path.join(migDir, dir, 'migration.sql');
console.log(`2/4  Appending prisma/sql/post_migrate.sql to ${path.relative(root, file)}…`);
fs.appendFileSync(file, `\n\n-- ===== post_migrate.sql (partial indexes, CHECKs, append-only ledger, row-level security) =====\n${fs.readFileSync(path.join(root, 'prisma', 'sql', 'post_migrate.sql'), 'utf8')}\n`);

if (process.env.PAUSE_BEFORE_APPLY === 'yes') { console.log(`\nPaused. Review ${file}, then run:  npx prisma migrate deploy && npx prisma generate\n`); process.exit(0); }
console.log('3/4  Applying to the database…');
run(['migrate', 'deploy']);
console.log('4/4  Generating the client…');
run(['generate']);
console.log('\n✔ Done. Next: pnpm seed:admin (creates the first Super Admin), then start the server.\n');
