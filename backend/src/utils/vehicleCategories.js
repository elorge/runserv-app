// backend/src/utils/vehicleCategories.js
//
// M13: ONE switch for which vehicle categories Runserv operates. Roadmap §10: "Do not leave TRICYCLE inconsistent between API and UI".
//   ENABLED_VEHICLE_CATEGORIES="CAR"            <- recommended for the Lagos pilot (one category)
//   default                  = "CAR,MOTORCYCLE,VAN"  (the blueprint launch categories; TRICYCLE is OUT until deliberately enabled)
// BIKE is the legacy driver-profile name for MOTORCYCLE and is treated as the same category.
'use strict';
const { AppError } = require('../middleware/errorHandler');

const KNOWN = ['CAR', 'MOTORCYCLE', 'VAN', 'TRICYCLE'];
const DEFAULT_ENABLED = 'CAR,MOTORCYCLE,VAN';

const normaliseCategory = (t) => {
  const u = String(t ?? '').trim().toUpperCase();
  return u === 'BIKE' ? 'MOTORCYCLE' : u;
};

const enabledCategories = (env = process.env) => {
  const raw = env.ENABLED_VEHICLE_CATEGORIES;
  const list = String(raw === undefined || raw === '' ? DEFAULT_ENABLED : raw).split(',').map(normaliseCategory).filter((c) => KNOWN.includes(c));
  return [...new Set(list)];
};

const isCategoryEnabled = (type, env = process.env) => enabledCategories(env).includes(normaliseCategory(type));

const assertCategoryEnabled = (type, env = process.env) => {
  if (isCategoryEnabled(type, env)) return;
  const e = new AppError(`${String(type || 'This vehicle category').toLowerCase()} service is not available yet.`, 400);
  e.code = 'VEHICLE_CATEGORY_DISABLED';
  throw e;
};

module.exports = { KNOWN, normaliseCategory, enabledCategories, isCategoryEnabled, assertCategoryEnabled };
