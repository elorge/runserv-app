#!/usr/bin/env node
// scripts/schema-to-rehearsal-sql.js — WP-02 REHEARSAL helper (sandbox/CI where the Prisma schema engine cannot be downloaded).
// Reads prisma/schema.prisma and prints PostgreSQL DDL close to what `prisma migrate diff --from-empty --to-schema-datamodel --script` produces:
// enums, tables, columns, defaults, primary keys, unique constraints/indexes, indexes. Foreign keys are OMITTED on purpose (rehearsal only).
// THIS IS NOT THE PRODUCTION BASELINE. Production baseline = `pnpm db:baseline` (Prisma's own output, see docs/DB_MIGRATIONS.md).
'use strict';
const fs = require('fs'); const path = require('path');
const src = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8').replace(/\/\/.*$/gm, '');
const q = (s) => `"${s}"`;
const enums = {}; const models = {};
for (const m of src.matchAll(/^enum\s+(\w+)\s*\{([^}]*)\}/gm)) enums[m[1]] = m[2].split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.split(/\s+/)[0]);
for (const m of src.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) models[m[1]] = m[2];
const out = [];
for (const [n, vals] of Object.entries(enums)) out.push(`CREATE TYPE ${q(n)} AS ENUM (${vals.map((v) => `'${v}'`).join(', ')});`);
const scalar = (t, attrs) => {
  const db = (attrs.match(/@db\.(\w+)(?:\(([^)]*)\))?/) || []);
  if (t === 'String') return db[1] === 'VarChar' ? `VARCHAR(${db[2]})` : 'TEXT';
  if (t === 'Int') return 'INTEGER'; if (t === 'BigInt') return 'BIGINT'; if (t === 'Float') return 'DOUBLE PRECISION'; if (t === 'Boolean') return 'BOOLEAN';
  if (t === 'DateTime') return db[1] === 'Timestamptz' ? `TIMESTAMPTZ(${db[2] || 3})` : db[1] === 'Date' ? 'DATE' : `TIMESTAMP(${db[2] || 3})`;
  if (t === 'Decimal') return db[1] === 'Decimal' ? `DECIMAL(${db[2]})` : 'DECIMAL(65,30)';
  if (t === 'Json') return 'JSONB'; if (t === 'Bytes') return 'BYTEA';
  if (enums[t]) return q(t);
  return null;
};
const idx = [];
for (const [name, body] of Object.entries(models)) {
  const cols = []; const pk = []; const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const l of lines) {
    if (l.startsWith('@@')) {
      const cl = (l.match(/\[([^\]]*)\]/) || [])[1]; if (!cl) continue;
      const fields = cl.split(',').map((x) => x.trim().replace(/\(.*\)/, ''));
      const mapNames = fields; // resolved below after column map
      if (l.startsWith('@@index')) idx.push({ name, kind: 'index', fields: mapNames });
      else if (l.startsWith('@@unique')) idx.push({ name, kind: 'unique', fields: mapNames });
      else if (l.startsWith('@@id')) pk.push(...fields);
      continue;
    }
    const m = l.match(/^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/); if (!m) continue;
    const [, f, t, list, opt, attrs] = m;
    const base = scalar(t, attrs); if (!base) continue;      // relation field
    const col = (attrs.match(/@map\("([^"]+)"\)/) || [])[1] || f;
    let def = '';
    const d = attrs.match(/@default\((.*?)\)(?:\s+@|\s*$)/); const dv = d ? d[1] : null;
    if (dv !== null) {
      if (/^autoincrement/.test(dv)) def = ''; else if (/^now/.test(dv)) def = ' DEFAULT CURRENT_TIMESTAMP';
      else if (/^dbgenerated\("(.*)"\)$/.test(dv)) def = ` DEFAULT ${dv.match(/^dbgenerated\("(.*)"\)$/)[1]}`;
      else if (/^(uuid|cuid)/.test(dv)) def = '';
      else if (/^\[\]$/.test(dv)) def = " DEFAULT ARRAY[]::" + base + "[]";
      else if (/^(true|false)$/.test(dv)) def = ` DEFAULT ${dv}`; else if (/^-?[\d.]+$/.test(dv)) def = ` DEFAULT ${dv}`;
      else if (/^"/.test(dv)) def = ` DEFAULT '${dv.slice(1, -1).replace(/'/g, "''")}'`;
      else if (enums[t]) def = ` DEFAULT '${dv}'`;
    }
    const type = list ? `${base}[]` : (/autoincrement/.test(attrs) ? 'SERIAL' : base);
    const notnull = (opt || list && dv === null && false) ? '' : ' NOT NULL';
    cols.push({ f, col, sql: `  ${q(col)} ${type}${notnull}${def}` });
    if (/@id\b/.test(attrs)) pk.push(f);
    if (/@unique\b/.test(attrs)) idx.push({ name, kind: 'unique', fields: [f] });
  }
  const colOf = (f) => (cols.find((c) => c.f === f) || { col: f }).col;
  models[name] = { cols, pk: pk.map(colOf), colOf };
  out.push(`CREATE TABLE ${q(name)} (\n${cols.map((c) => c.sql).join(',\n')}${pk.length ? `,\n  PRIMARY KEY (${models[name].pk.map(q).join(', ')})` : ''}\n);`);
}
for (const i of idx) {
  const mm = models[i.name]; const cols = i.fields.map((f) => q(mm.colOf(f)));
  if (!i.fields.every((f) => mm.cols.some((c) => c.f === f))) continue;
  const nm = `${i.name}_${i.fields.map((f) => mm.colOf(f)).join('_')}_${i.kind === 'unique' ? 'key' : 'idx'}`.slice(0, 63);
  out.push(`CREATE ${i.kind === 'unique' ? 'UNIQUE ' : ''}INDEX ${q(nm)} ON ${q(i.name)} (${cols.join(', ')});`);
}
process.stdout.write(out.join('\n') + '\n');
