// mobile/src/services/liveLocationCore.js
// ONE GPS watcher for the driver / courier app, shared by every screen that needs the position.
// Pure logic (no React, no socket import) so it can be tested; services/liveLocation.js wires it to expo-location and the socket.
//
// Why this exists: Active ride, Active delivery and the Dashboard each used to start their own watcher. They could leak on
// unmount, and each stopped when the driver left that screen. Now a screen just `acquire`s the service while it needs GPS and
// `release`s it on unmount; the single watcher runs while anyone holds it and is removed when the last owner lets go.
//
// Each fix keeps heading, speed and accuracy (the old code sent only latitude/longitude).

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export const WATCH_INTERVAL_MS = 3000;       // at most one fix per 3 s: smooth enough to animate, light on battery and data
export const WATCH_DISTANCE_M  = 5;

/** expo-location position -> the ping we send. heading/speed come as -1 when unknown, which becomes null. */
export const toPing = (position) => {
  const c = position?.coords;
  if (!c) return null;
  const latitude = finite(c.latitude), longitude = finite(c.longitude);
  if (latitude === null || longitude === null) return null;
  const heading = finite(c.heading), speed = finite(c.speed), accuracy = finite(c.accuracy);
  return {
    latitude, longitude,
    accuracy: accuracy !== null && accuracy >= 0 ? accuracy : null,
    heading:  heading  !== null && heading  >= 0 ? heading  : null,
    speed:    speed    !== null && speed    >= 0 ? speed    : null,   // metres per second
    timestamp: Number.isFinite(position.timestamp) ? position.timestamp : Date.now(),
  };
};

export class LiveLocationCore {
  /** @param {{ location: object, send: (ping:object)=>void }} deps  location = expo-location module (or a fake in tests) */
  constructor({ location, send }) {
    this.location = location;
    this.send = send;
    this.owners = new Set();
    this.listeners = new Set();
    this.sub = null;
    this.gen = 0;                 // bumped on every stop, so a start that finishes late knows it was cancelled
    this.status = 'idle';         // idle | starting | running | denied | consent_required | error
    this.last = null;
  }

  _set(status) { this.status = status; this._emit(); }
  _emit() { for (const l of this.listeners) { try { l({ status: this.status, fix: this.last }); } catch { /* a bad listener must not stop the others */ } } }

  /** Screens listen here for the latest fix and the status. Replays the current state at once. Returns an unsubscribe function. */
  subscribe(listener) {
    this.listeners.add(listener);
    try { listener({ status: this.status, fix: this.last }); } catch { /* ignore */ }
    return () => this.listeners.delete(listener);
  }

  get running() { return this.status === 'running' || this.status === 'starting'; }

  /** A screen needs GPS. Safe to call many times with different owners; only one watcher is ever created. */
  async acquire(owner) {
    this.owners.add(owner);
    if (this.running) return this.status;
    return this._start();
  }

  /** The screen is done. The watcher is removed when the last owner releases. */
  release(owner) {
    this.owners.delete(owner);
    if (this.owners.size === 0) this.stop();
  }

  async _start() {
    const gen = ++this.gen;
    this._set('starting');
    try {
      const perm = await this.location.requestForegroundPermissionsAsync();
      if (gen !== this.gen) return this.status;
      if (perm?.status !== 'granted') { this._set('denied'); return 'denied'; }

      // Show something straight away instead of waiting for the first watch callback.
      try {
        const first = await this.location.getCurrentPositionAsync({ accuracy: this.location.Accuracy?.High });
        if (gen === this.gen) this._handle(first);
      } catch { /* the watcher below will deliver the first fix */ }
      if (gen !== this.gen) return this.status;

      const sub = await this.location.watchPositionAsync(
        { accuracy: this.location.Accuracy?.High, timeInterval: WATCH_INTERVAL_MS, distanceInterval: WATCH_DISTANCE_M },
        (pos) => this._handle(pos),
      );
      if (gen !== this.gen) { try { sub?.remove?.(); } catch { /* already gone */ } return this.status; }   // released while starting: no leak
      this.sub = sub;
      this._set('running');
      return 'running';
    } catch {
      if (gen === this.gen) this._set('error');
      return 'error';
    }
  }

  _handle(position) {
    const ping = toPing(position);
    if (!ping) return;
    this.last = ping;
    this._emit();
    if (this.status === 'running' || this.status === 'starting') { try { this.send(ping); } catch { /* socket not ready: the next fix will go */ } }
  }

  /** The server said consent is missing or withdrawn: stop watching and tell the screens. */
  consentRequired() {
    this._removeWatcher();
    this._set('consent_required');
  }

  _removeWatcher() {
    this.gen++;
    try { this.sub?.remove?.(); } catch { /* already gone */ }
    this.sub = null;
  }

  stop() {
    this._removeWatcher();
    this.owners.clear();
    this.last = this.last;          // keep the last fix so a screen opened right after still has something to show
    this._set('idle');
  }
}
