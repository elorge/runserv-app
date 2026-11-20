# M10: Runserv Maps, live tracking and driver location consent

## Summary
Live vehicle tracking now works end to end for drivers and couriers, only with the driver's consent, and the map layer is rewritten for MapLibre React Native v11.

## Backend
- **Consent** (`tracking.service.js`, `locationConsent.controller.js`): versioned (`CONSENT_VERSION`), `GET/PUT /api/drivers/location-consent` and `/api/partners/location-consent`, audit trail. Going online without valid consent returns 403 `LOCATION_CONSENT_REQUIRED`. Withdrawing consent takes the person offline and erases the stored position; it is **blocked during a trip** (`LOCATION_CONSENT_ACTIVE_TRIP`).
- **Sockets** (`socket.service.js`): one handler for drivers and couriers, accepts `driver:*` and `partner:*` events from either role (old courier builds work). Consent is checked on **every** ping; pings are validated (range, accuracy, age, impossible jumps); stale after 90 s. Exact position goes only to the assigned customer (`driver:location:update` / `partner:location:update`, now with `rideId`/`deliveryId`, heading, speed, accuracy). Couriers who go online join the partner pool. **Reconnect no longer rejoins the pool without valid consent** (the gap behind the failing test).
- **Trip end**: `ride:tracking:ended` / `delivery:tracking:ended` on completion or cancel.
- **Privacy**: ride/delivery endpoints return a safe public profile only (no licence, ID, guarantor, insurance, coordinates). `getActiveRide` / `getActiveDelivery` return `driverLocation` / `partnerLocation` (exact, assigned customer only, with `stale`). Nearby lists require consent and a fix under 90 s old and return `approxLat/approxLng` rounded to ~110 m.
- **Pickup details** (`pickupSource`, `pickupAccuracyM`, `pickupCapturedAt`) saved with each booking.
- **Error handler** now passes `LOCATION_*` codes to the apps.
- **Schema**: new fields on `DriverProfile`, `DeliveryPartnerProfile`, `Ride`, `Delivery`. For an existing database run `backend/prisma/sql/m10_location_consent.sql` (additive), then `npx prisma generate`.

## Mobile
- `components/MapLibreMapView.js` rewritten for v11 (`Map`, `Camera`, `ViewAnnotation`, `GeoJSONSource`, `Layer`, `Images`, `UserLocation`). Route, geofence circles, clustered nearby-vehicle layer, RS pins, animated assigned vehicle (`AnimatedVehicle`).
- `services/liveLocationCore.js` + `liveLocation.js`: ONE GPS watcher (`acquire/release`), sends heading/speed/accuracy, stops on consent withdrawal.
- `screens/Shared/LocationSharingScreen.js` (consent + Stop sharing) and `components/LocationSharingRow.js` on both dashboards. Going online without consent opens the consent screen.
- `services/socket.js` role-aware (`setRole`, `driver:*` / `partner:*`), sends full fixes.
- Customer tracking screens: heading kept, camera only follows while "following" (Recentre button after a manual pan), stale "Last seen" label, listener removal fixed, exact position from the API field not the profile.
- Removed `utils/permissions.js` (imported missing packages); `LocationContext` now returns real GPS, never a fake centre.
- `package.json`: `@maplibre/maplibre-react-native` 11.5.1; `app.config.js` plugin added. English strings under `locationSharing.*`.

## Tests
Backend: 46 existing suites + `tracking`, `locationConsent`, `locationSocket`, `trackingEnded` = **729 tests passing**. Mobile (scratch Jest harness, pure logic): **107 passing** including the GPS service (one watcher, no leak on early release, consent stop) and liveFix.

## Not verified (needs your environment)
- `prisma validate` / `generate` and the SQL file against a real database (engine download blocked here).
- Anything on a phone: MapLibre needs a dev client / EAS build (not Expo Go). Run `npm install` in `mobile/` to create the lockfile.
- Foreground GPS only; no background tracking (needs a separate store disclosure and foreground-service work).
- Radar pulse rings are not ported to v11.

## Decision made
Withdrawing consent is blocked mid-trip (matches the existing "no going offline mid-trip" rule). To allow instant withdrawal, remove the active-trip check in `locationConsent.controller.js`.
