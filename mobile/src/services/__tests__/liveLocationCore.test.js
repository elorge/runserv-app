import { LiveLocationCore, toPing } from '../liveLocationCore';

const pos = (o = {}) => ({ coords: { latitude: 6.5, longitude: 3.3, accuracy: 8, heading: 90, speed: 5, ...o }, timestamp: 1000 });
const makeLoc = ({ perm = 'granted', delay = 0 } = {}) => {
  const removed = []; let cb = null; let watchers = 0;
  return {
    removed, get watchers() { return watchers; }, emit: (p) => cb && cb(p),
    Accuracy: { High: 5 },
    requestForegroundPermissionsAsync: async () => ({ status: perm }),
    getCurrentPositionAsync: async () => pos(),
    watchPositionAsync: async (_o, c) => { await new Promise((r) => setTimeout(r, delay)); cb = c; watchers++; return { remove: () => removed.push(1) }; },
  };
};

describe('toPing', () => {
  test('keeps heading, speed and accuracy', () => expect(toPing(pos())).toMatchObject({ latitude: 6.5, longitude: 3.3, heading: 90, speed: 5, accuracy: 8, timestamp: 1000 }));
  test('unknown heading/speed (-1) become null', () => expect(toPing(pos({ heading: -1, speed: -1 }))).toMatchObject({ heading: null, speed: null }));
  test('bad coordinates give null', () => { expect(toPing(pos({ latitude: NaN }))).toBeNull(); expect(toPing(null)).toBeNull(); });
});

describe('LiveLocationCore', () => {
  test('two owners share ONE watcher; it is removed only when the last releases', async () => {
    const loc = makeLoc(); const sent = [];
    const core = new LiveLocationCore({ location: loc, send: (p) => sent.push(p) });
    await core.acquire('dashboard'); await core.acquire('active-ride');
    expect(loc.watchers).toBe(1);
    core.release('active-ride'); expect(loc.removed.length).toBe(0);
    core.release('dashboard'); expect(loc.removed.length).toBe(1); expect(core.status).toBe('idle');
  });
  test('concurrent acquires still make one watcher', async () => {
    const loc = makeLoc({ delay: 10 });
    const core = new LiveLocationCore({ location: loc, send: () => {} });
    await Promise.all([core.acquire('a'), core.acquire('b')]);
    expect(loc.watchers).toBe(1);
  });
  test('released while starting: no leaked watcher', async () => {
    const loc = makeLoc({ delay: 20 });
    const core = new LiveLocationCore({ location: loc, send: () => {} });
    const p = core.acquire('a'); core.release('a'); await p;
    await new Promise((r) => setTimeout(r, 40));
    expect(loc.removed.length).toBe(loc.watchers);   // every watcher that was created was removed
  });
  test('every fix is sent with heading/speed/accuracy and reaches subscribers', async () => {
    const loc = makeLoc(); const sent = []; const seen = [];
    const core = new LiveLocationCore({ location: loc, send: (p) => sent.push(p) });
    core.subscribe(({ fix }) => fix && seen.push(fix));
    await core.acquire('a'); loc.emit(pos({ latitude: 6.6, heading: 10 }));
    expect(sent.at(-1)).toMatchObject({ latitude: 6.6, heading: 10, speed: 5, accuracy: 8 });
    expect(seen.at(-1).latitude).toBe(6.6);
  });
  test('permission denied -> status denied, nothing sent', async () => {
    const sent = []; const core = new LiveLocationCore({ location: makeLoc({ perm: 'denied' }), send: (p) => sent.push(p) });
    expect(await core.acquire('a')).toBe('denied'); expect(sent).toEqual([]);
  });
  test('consentRequired stops the watcher and tells subscribers', async () => {
    const loc = makeLoc(); const core = new LiveLocationCore({ location: loc, send: () => {} });
    const states = []; core.subscribe((s) => states.push(s.status));
    await core.acquire('a'); core.consentRequired();
    expect(loc.removed.length).toBe(1); expect(states.at(-1)).toBe('consent_required');
  });
});
