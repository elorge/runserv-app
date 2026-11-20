// mobile/src/utils/vehicleIcons.js
// Runserv vehicle artwork (top-down, all drawn facing NORTH so a bearing in
// degrees rotates them directly). Source sheets: Runserv icon collection M8.
import { VEHICLE_ICON_DATA } from './vehicleIconData';

export const VEHICLE_ICON_SOURCES = {
  car_blue:       require('../../assets/vehicles/car_blue.png'),
  car_white:      require('../../assets/vehicles/car_white.png'),
  car_black:      require('../../assets/vehicles/car_black.png'),
  van:            require('../../assets/vehicles/van.png'),
  motorcycle:     require('../../assets/vehicles/motorcycle.png'),
  bike:           require('../../assets/vehicles/bike.png'),
  tricycle:       require('../../assets/vehicles/tricycle.png'),
  tricycle_cargo: require('../../assets/vehicles/tricycle_cargo.png'),
  van_cargo:      require('../../assets/vehicles/van_cargo.png'),
};

// Size (px, square canvas) each artwork is drawn at on the map.
export const VEHICLE_ICON_SIZE = {
  car_blue: 54, car_white: 54, car_black: 54, van: 60, motorcycle: 52,
  bike: 46, tricycle: 52, tricycle_cargo: 54, van_cargo: 58,
};

/**
 * Pick the artwork for a backend VehicleType (BIKE|CAR|MOTORCYCLE|VAN|TRICYCLE).
 * opts.colour: 'blue' | 'white' | 'black' (cars only, default blue = brand)
 * opts.cargo:  true for delivery vehicles (box body)
 */
export function resolveVehicleIconKey(vehicleType, opts = {}) {
  const t = String(vehicleType || 'CAR').toUpperCase();
  switch (t) {
    case 'MOTORCYCLE': return 'motorcycle';
    case 'BIKE':       return 'bike';
    case 'TRICYCLE':   return opts.cargo ? 'tricycle_cargo' : 'tricycle';
    case 'VAN':        return opts.cargo ? 'van_cargo' : 'van';
    case 'CAR':
    default: {
      const c = String(opts.colour || 'blue').toLowerCase();
      return c === 'white' ? 'car_white' : c === 'black' ? 'car_black' : 'car_blue';
    }
  }
}

export const vehicleIconSource  = (key) => VEHICLE_ICON_SOURCES[key] || VEHICLE_ICON_SOURCES.car_blue;
export const vehicleIconDataUri = (key) => VEHICLE_ICON_DATA[key]    || VEHICLE_ICON_DATA.car_blue;
export const vehicleIconSize    = (key) => VEHICLE_ICON_SIZE[key]    || 54;

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
