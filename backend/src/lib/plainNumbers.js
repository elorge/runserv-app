// backend/src/lib/plainNumbers.js
// ─────────────────────────────────────────────────────────────────────────────
// Money columns are stored as exact NUMERIC(14,2) in the database. Prisma hands NUMERIC back as Decimal objects; the
// rest of the app does ordinary arithmetic on plain numbers. This turns every Decimal in a query result into a number
// at the edge. Safe because a 2-decimal value up to 999,999,999,999.99 is exactly representable once rounded to cents.
// Writes need no conversion (Prisma accepts numbers for Decimal columns) and the database does the adding, so stored
// totals never drift.
// ─────────────────────────────────────────────────────────────────────────────
const isDecimal = (v) =>
  v !== null && typeof v === 'object' && typeof v.toNumber === 'function' && typeof v.toFixed === 'function'
  && 'd' in v && 'e' in v && 's' in v;

const plain = (v) => {
  if (v === null || v === undefined) return v;
  if (isDecimal(v)) return v.toNumber();
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = plain(v[i]); return v; }
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    for (const k of Object.keys(v)) v[k] = plain(v[k]);
  }
  return v;   // Date, Buffer, BigInt, strings, numbers are left alone
};

const extension = {
  name: 'plain-numbers',
  query: {
    $allModels: { async $allOperations({ args, query }) { return plain(await query(args)); } },
    async $allOperations({ args, query }) { return plain(await query(args)); },
  },
};

module.exports = { plain, isDecimal, extension };
