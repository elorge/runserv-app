// mobile/src/utils/vehicleMotion.js
// Smooth, honest vehicle animation (Maps guide, section 8). Pure functions, no React, so it is easy to test.
//
//   const m = new VehicleMotion();
//   m.push({ lat, lng, heading?, speed?, timestamp? }, now)     // a real accepted GPS fix
//   m.sample(now) -> { lat, lng, rotation, stale, ageMs, moving }   // call each animation frame
//
// What it does:
//   1. keeps the last drawn position and glides to the next real fix over a controlled interval (never jumps);
//   2. turns the icon the short way round, using the phone's heading when it has one and the bearing of the move otherwise;
//   3. ignores GPS jitter: a small move while the car is (nearly) stationary does not move or turn the icon;
//   4. marks the vehicle STALE when no fix has arrived for STALE_AFTER_MS, instead of leaving it looking live;
//   5. never invents movement: it only ever glides between positions the driver actually reported (no dead reckoning).
import { smoothHeading, metresBetween } from './geoMath';

export const STALE_AFTER_MS = 90 * 1000;     // same rule as the server
export const JITTER_M       = 4;             // moves smaller than this, while slow, are treated as noise
export const MAX_JITTER_M   = 15;            // ...and a poor fix (accuracy 30 m) widens that to half its accuracy, up to this
export const MIN_GLIDE_MS   = 800;
export const MAX_GLIDE_MS   = 5000;
export const TELEPORT_M     = 800;           // a bigger jump than this (e.g. after reconnect) snaps instead of gliding across the city
export const TURN_MS        = 600;           // time to turn the icon to its new heading

export const bearingBetween = (lat1, lng1, lat2, lng2) => {
  const r = (x) => (x * Math.PI) / 180;
  const dLng = r(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(r(lat2));
  const x = Math.cos(r(lat1)) * Math.sin(r(lat2)) - Math.sin(r(lat1)) * Math.cos(r(lat2)) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
};

export const easeInOut = (k) => (k <= 0 ? 0 : k >= 1 ? 1 : k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
const lerp = (a, b, k) => a + (b - a) * k;

/** Glide time between two fixes: the gap between them, clamped so the car neither crawls nor races. */
export const glideDuration = (gapMs) => Math.max(MIN_GLIDE_MS, Math.min(MAX_GLIDE_MS, Number.isFinite(gapMs) ? gapMs : 3000));

export const isStale = (lastFixAt, now = Date.now(), after = STALE_AFTER_MS) =>
  !lastFixAt || !Number.isFinite(lastFixAt) || now - lastFixAt > after;

/** "12 s ago" / "3 min ago" for the stale label. */
export const ageLabel = (ageMs) => {
  const s = Math.max(0, Math.round(ageMs / 1000));
  return s < 60 ? `${s}s` : `${Math.round(s / 60)} min`;
};

export class VehicleMotion {
  constructor() {
    this.from = null;         // where the current glide started
    this.to = null;           // the latest real fix
    this.t0 = 0;              // when the glide started
    this.dur = MIN_GLIDE_MS;
    this.lastFixAt = null;    // time of the latest real fix
    this.lastPushAt = null;
    this.targetHeading = null;
    this.rotation = null;     // cumulative angle drawn (never wraps, so CSS-style turns take the short way)
    this.rotFrom = null; this.rotT0 = 0;
    this.moving = false;
  }

  /** A new accepted fix. Returns false when it was ignored (older than the one we have, or bad coordinates). */
  push(fix, now = Date.now()) {
    if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) return false;
    const at = Number.isFinite(fix.timestamp) ? fix.timestamp : now;
    if (this.lastFixAt != null && at < this.lastFixAt) return false;       // out-of-order: never go backwards

    if (!this.to) {                                                       // first fix: appear in place
      this.from = { lat: fix.lat, lng: fix.lng }; this.to = { ...this.from };
      this.t0 = now; this.dur = MIN_GLIDE_MS;
      this.lastFixAt = at; this.lastPushAt = now;
      if (Number.isFinite(fix.heading)) { this.rotation = fix.heading; this.targetHeading = fix.heading; }
      return true;
    }

    const cur = this.sample(now);
    const moved = metresBetween(cur.lat, cur.lng, fix.lat, fix.lng);
    const speed = Number.isFinite(fix.speed) ? fix.speed : null;           // m/s
    const slow = speed !== null ? speed < 1 : true;
    const gap = this.lastPushAt != null ? now - this.lastPushAt : 3000;

    const noise = Math.min(MAX_JITTER_M, Math.max(JITTER_M, (Number.isFinite(fix.accuracy) ? fix.accuracy : 0) * 0.5));
    if (slow && moved < noise) {                                       // stationary jitter: stay put, keep the clock fresh
      this.lastFixAt = at; this.lastPushAt = now; this.moving = false;
      if (Number.isFinite(fix.heading) && speed !== null && speed > 0.5) this._turnTo(fix.heading, now);
      return true;
    }

    this.from = { lat: cur.lat, lng: cur.lng };
    this.to = { lat: fix.lat, lng: fix.lng };
    this.t0 = now;
    this.dur = moved > TELEPORT_M ? 0 : glideDuration(gap);
    this.moving = true;
    this.lastFixAt = at; this.lastPushAt = now;

    if (Number.isFinite(fix.heading) && !slow) this._turnTo(fix.heading, now);                 // trust the phone's heading while moving
    else if (moved >= noise) this._turnTo(bearingBetween(cur.lat, cur.lng, fix.lat, fix.lng), now);  // else the bearing of the move
    return true;
  }

  _turnTo(deg, now) {
    const from = this.rotation;
    this.targetHeading = deg;
    this.rotFrom = from; this.rotT0 = now;
    this.rotTarget = smoothHeading(from, deg);
    if (from == null) this.rotation = deg;
  }

  /** Where to draw the vehicle at `now`. */
  sample(now = Date.now()) {
    if (!this.to) return { lat: null, lng: null, rotation: 0, stale: true, ageMs: Infinity, moving: false };
    const k = this.dur <= 0 ? 1 : easeInOut((now - this.t0) / this.dur);
    const lat = lerp(this.from.lat, this.to.lat, k), lng = lerp(this.from.lng, this.to.lng, k);
    if (this.rotTarget != null && this.rotFrom != null) {
      const rk = easeInOut((now - this.rotT0) / TURN_MS);
      this.rotation = lerp(this.rotFrom, this.rotTarget, rk);
      if (rk >= 1) { this.rotFrom = null; this.rotation = this.rotTarget; }
    }
    const ageMs = this.lastFixAt == null ? Infinity : now - this.lastFixAt;
    return {
      lat, lng,
      rotation: this.rotation ?? 0,
      stale: isStale(this.lastFixAt, now),
      ageMs,
      moving: this.moving && k < 1,
    };
  }

  /** True while an animation frame is still needed (gliding or turning). The stale flag also needs an occasional frame. */
  isAnimating(now = Date.now()) {
    if (!this.to) return false;
    const gliding = this.dur > 0 && now - this.t0 < this.dur;
    const turning = this.rotFrom != null && now - this.rotT0 < TURN_MS;
    return gliding || turning;
  }
}
