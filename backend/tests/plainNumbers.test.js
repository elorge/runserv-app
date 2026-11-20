const { Decimal } = require('@prisma/client/runtime/library');
const { plain } = require('../src/lib/plainNumbers');

describe('Decimal → number at the database edge', () => {
  it('converts nested Decimals, keeps dates and strings', () => {
    const d = new Date();
    const out = plain({ a: new Decimal('12.34'), b: [new Decimal('0.10'), { c: new Decimal('999999999999.99') }], d, e: 'x', f: null });
    expect(out.a).toBe(12.34);
    expect(out.b[0]).toBe(0.1);
    expect(out.b[1].c).toBe(999999999999.99);
    expect(out.d).toBe(d);
    expect(out.e).toBe('x');
    expect(out.f).toBeNull();
  });
  it('stored sums stay exact where float arithmetic drifts', () => {
    let float = 0; let dec = new Decimal(0);
    for (let i = 0; i < 1000; i++) { float += 0.1; dec = dec.plus('0.10'); }
    expect(float).not.toBe(100);          // the old behaviour
    expect(plain(dec)).toBe(100);         // NUMERIC arithmetic
  });
});
