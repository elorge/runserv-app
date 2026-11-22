import { buildMotion, routeUpTo, kmToFraction } from '../EarnMap';
import { tapeSegments } from '../EarnViz';

describe('buildMotion (vehicle path)', () => {
  const square = [{ x: 0, y: 100 }, { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
  it('inputs strictly increase from 0 to 1 and arrays line up', () => {
    const m = buildMotion(square);
    expect(m.input[0]).toBe(0);
    expect(m.input[m.input.length - 1]).toBe(1);
    for (let i = 1; i < m.input.length; i += 1) expect(m.input[i]).toBeGreaterThan(m.input[i - 1]);
    expect(m.xs).toHaveLength(m.input.length);
    expect(m.rot).toHaveLength(m.input.length);
  });
  it('faces along each street (north, east, south) and turns at the corners', () => {
    const m = buildMotion(square);
    expect(m.rot[0]).toBeCloseTo(0);           // north
    expect(m.rot.some((d) => Math.abs(d - 90) < 1e-6)).toBe(true);   // east
    expect(m.rot[m.rot.length - 1]).toBeCloseTo(180);                // south
  });
  it('turns quickly: the heading is constant along each street', () => {
    const m = buildMotion(square);
    // between a corner\'s departure stop and the next corner\'s arrival stop the heading must not change
    const idx = m.input.findIndex((t) => t > 0.4 && t < 0.6);
    if (idx > 0) expect(m.rot[idx]).toBeCloseTo(m.rot[idx - 1], 3);
  });
  it('handles a two-point line', () => {
    const m = buildMotion([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    expect(m.input).toEqual([0, 1]);
  });
});

describe('courier route', () => {
  it('a longer distance draws a longer route', () => {
    const len = (pts) => pts.reduce((a, p, i) => (i ? a + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) : 0), 0);
    expect(len(routeUpTo(kmToFraction(20), 300, 200))).toBeGreaterThan(len(routeUpTo(kmToFraction(3), 300, 200)));
  });
});

describe('tapeSegments (shift drawn as runs and waits)', () => {
  it('fills the shift exactly and counts the runs', () => {
    const segs = tapeSegments({ shiftMin: 480, runMin: 40, gapMin: 20 });
    expect(segs.reduce((a, s) => a + s.min, 0)).toBeCloseTo(480);
    expect(segs.filter((s) => s.kind === 'run')).toHaveLength(8);
  });
  it('a quieter day (longer waits) fits fewer runs', () => {
    const busy = tapeSegments({ shiftMin: 480, runMin: 40, gapMin: 5 }).filter((s) => s.kind === 'run').length;
    const quiet = tapeSegments({ shiftMin: 480, runMin: 40, gapMin: 30 }).filter((s) => s.kind === 'run').length;
    expect(quiet).toBeLessThan(busy);
  });
  it('returns nothing for bad input', () => {
    expect(tapeSegments({ shiftMin: 0, runMin: 40, gapMin: 5 })).toEqual([]);
  });
});
