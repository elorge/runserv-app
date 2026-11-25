'use strict';
// WP-02: every hand-written SQL file must be in the authoritative order file, exactly once, and be written to be re-runnable.
const fs = require('fs'); const path = require('path');
const dir = path.join(__dirname, '..', 'prisma', 'sql');
const listed = fs.readFileSync(path.join(dir, 'ORDER.txt'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
const onDisk = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));
test('ORDER.txt lists every SQL file exactly once and nothing that does not exist', () => {
  expect([...listed].sort()).toEqual([...onDisk].sort());
  expect(new Set(listed).size).toBe(listed.length);
});
test('post_migrate.sql runs first (it creates the base constraints later files rely on)', () => { expect(listed[0]).toBe('post_migrate.sql'); });
test('no SQL file uses a bare CREATE TABLE / ADD COLUMN / CREATE INDEX without IF NOT EXISTS (re-run safety)', () => {
  for (const f of onDisk) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8').replace(/--.*$/gm, '');
    const bad = [...s.matchAll(/CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)(?!\s+IF\s+NOT\s+EXISTS)\s/gi)].length + [...s.matchAll(/ADD\s+COLUMN(?!\s+IF\s+NOT\s+EXISTS)\s/gi)].length;
    expect({ f, bad }).toEqual({ f, bad: 0 });
  }
});
