// backend/src/services/driverVehicleCompat.js
//
// ONE central driver ↔ vehicle compatibility matrix (Launch Readiness Guide §3.3).
// Pure functions: the server calls this at assignment AND again at go-online / accept, so a stale assignment is never
// trusted. Every refusal carries a stable `code` that the driver app and fleet portal can translate.
//
// IMPORTANT: the category → credential rules below are a PROVISIONAL engineering default. The legally required licence
// classes and permits for cars, motorcycles, vans and tricycles in Nigeria/Lagos must be confirmed by qualified local
// advisers before launch (guide §3.2). Extra required credentials per category can be configured without a code change:
//   FLEET_DRIVER_CREDENTIALS_CAR="riderCardUrl"   (comma-separated DriverProfile fields)
'use strict';
const { isCategoryEnabled } = require('../utils/vehicleCategories');
const { licenceEnforced, checkLicence } = require('./driverLicence.service');

/** Which DriverProfile.vehicleType values may operate which FleetVehicle.vehicleType. Reviewed list, not inferred. */
const COMPATIBLE_TYPES = {
  CAR:        ['CAR'],
  MOTORCYCLE: ['MOTORCYCLE', 'BIKE'],
  BIKE:       ['MOTORCYCLE', 'BIKE'],
  VAN:        ['VAN'],
  TRICYCLE:   ['TRICYCLE'],
};

/** Credentials every driver must have on file regardless of category (DriverProfile column names). */
const BASE_CREDENTIALS = ['licenseNumber', 'licenseImageUrl'];

const CREDENTIAL_LABEL = {
  licenseNumber: 'driving licence number',
  licenseImageUrl: 'driving licence image',
  riderCardUrl: "rider's card",
  helmetPhotoUrl: 'helmet photo',
  dispatchPermitUrl: 'dispatch permit',
  hackneyCertUrl: 'hackney certificate',
  roadWorthinessUrl: 'road-worthiness certificate',
  insuranceUrl: 'insurance certificate',
};

const extraCredentials = (type, env = process.env) =>
  String(env[`FLEET_DRIVER_CREDENTIALS_${type}`] ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const fail = (code, message, extra = {}) => ({ code, message, ...extra });

/**
 * May this driver operate this fleet vehicle?
 *   driver  = { id?, isActive?, driverProfile: DriverProfile | null }   (a User with its driverProfile)
 *   vehicle = FleetVehicle  (vehicleType, status, isActive, fleetPartnerId)
 *   fleetPartner = FleetPartner (id, status)  — optional; when given, vehicle ownership is checked
 * @returns {{ ok:boolean, failures:{code:string,message:string}[] }}
 */
const checkDriverVehicle = ({ driver, vehicle, fleetPartner = null }, { env = process.env } = {}) => {
  const failures = [];
  const p = driver?.driverProfile ?? null;

  if (!driver || driver.isActive === false) failures.push(fail('DRIVER_SUSPENDED', 'The driver account is not active.'));
  if (!p) {
    failures.push(fail('DRIVER_NO_PROFILE', 'This person has not completed Runserv driver onboarding.'));
  } else {
    if (p.isRejected) failures.push(fail('DRIVER_REJECTED', 'The driver was rejected by Runserv.'));
    else if (!p.isApproved) failures.push(fail('DRIVER_NOT_APPROVED', 'The driver is not yet approved by Runserv.'));
  }

  if (!vehicle) {
    failures.push(fail('VEHICLE_NOT_FOUND', 'Vehicle not found.'));
  } else {
    if (vehicle.status !== 'ACTIVE' || vehicle.isActive === false) failures.push(fail('VEHICLE_NOT_ACTIVE', `The vehicle is ${String(vehicle.status).toLowerCase()}.`));
    if (fleetPartner && vehicle.fleetPartnerId !== fleetPartner.id) failures.push(fail('VEHICLE_WRONG_FLEET', 'The vehicle belongs to a different fleet.'));
  }

  if (vehicle && !isCategoryEnabled(vehicle.vehicleType, env)) failures.push(fail('VEHICLE_CATEGORY_DISABLED', `${String(vehicle.vehicleType).toLowerCase()} service is not available yet.`));
  if (p && vehicle && licenceEnforced(env)) failures.push(...checkLicence({ profile: p, category: vehicle.vehicleType, env }).failures);

  if (p && vehicle) {
    const allowed = COMPATIBLE_TYPES[vehicle.vehicleType];
    if (!allowed) failures.push(fail('VEHICLE_CATEGORY_UNSUPPORTED', `Vehicle category ${vehicle.vehicleType} has no reviewed compatibility rule.`));
    else if (!allowed.includes(p.vehicleType)) {
      failures.push(fail('DRIVER_VEHICLE_INCOMPATIBLE', `This driver is registered for ${String(p.vehicleType).toLowerCase()} work and cannot operate a ${String(vehicle.vehicleType).toLowerCase()}.`, { driverType: p.vehicleType, vehicleType: vehicle.vehicleType }));
    }
    const needed = [...BASE_CREDENTIALS, ...extraCredentials(vehicle.vehicleType, env)];
    for (const field of new Set(needed)) {
      if (!p[field]) failures.push(fail('DRIVER_CREDENTIAL_MISSING', `The driver's ${CREDENTIAL_LABEL[field] || field} is missing.`, { credential: field }));
    }
  }
  return { ok: failures.length === 0, failures };
};

module.exports = { COMPATIBLE_TYPES, BASE_CREDENTIALS, extraCredentials, checkDriverVehicle };
