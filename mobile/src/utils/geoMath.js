// mobile/src/utils/geoMath.js — small pure geometry helpers shared by the map code.
// Shortest-way rotation: returns the new cumulative angle so an icon turning
// from 350° to 10° moves 20°, not 340° backwards.
export function smoothHeading(prevAngle, nextBearing) {
  if (prevAngle == null) return nextBearing;
  const cur = ((prevAngle % 360) + 360) % 360;
  let delta = nextBearing - cur;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return prevAngle + delta;
}

// Metres between two points (small distances; equirectangular approximation).
export function metresBetween(lat1, lng1, lat2, lng2) {
  const k = 111320;
  const dy = (lat2 - lat1) * k;
  const dx = (lng2 - lng1) * k * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  return Math.sqrt(dx * dx + dy * dy);
}

// GPS jitter guard: ignore heading changes for moves shorter than this.
export const MIN_HEADING_MOVE_M = 4;
