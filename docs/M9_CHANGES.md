# M9 changes: vehicle icons, live-marker upgrade, brand colours

## Vehicle artwork (mobile/assets/vehicles)
Cut out of the five RS icon sheets, made transparent, rotated so every vehicle faces NORTH
(bearing 0°), padded square so rotation about the centre is clean. 256 px for native, 96 px for the map WebView.
car_blue / car_white / car_black, van, motorcycle, bike (scooter), tricycle (keke), tricycle_cargo, van_cargo,
plus map pieces for later: pin, pulse_dot, route, selected_halo, eta_bubble, logo_mark.
Backend VehicleType -> artwork: CAR -> car_*, VAN -> van, MOTORCYCLE -> motorcycle, BIKE -> bike, TRICYCLE -> tricycle.
Delivery partners pass `cargo: true` for the box-body versions.

## Code
- src/utils/vehicleIcons.js: type -> artwork, sizes, shortest-way heading smoothing, jitter guard (heading ignores moves under 4 m).
- src/utils/vehicleIconData.js: GENERATED base64 copies (WebView cannot require assets). Regenerate if artwork changes.
- OsmMapView (Leaflet): tracked marker and driver pins draw the vehicle art, glide (CSS) and rotate; arrow fallback kept.
- SmartMapView (Google path): same art via Image, same smoothing.
- Screens now pass the vehicle: RideTrackingScreen, ActiveRideScreen, DeliveryTrackingScreen, ActiveDeliveryScreen.
- setDriverPins accepts { vehicleType, colour, cargo, heading } per pin, ready for the nearby-vehicles layer.
- Tests: src/utils/__tests__/vehicleIcons.test.js (5 pass in a scratch harness; run `pnpm test` after `pnpm install`).

## Brand colours (from the logo)
Electric blue #0092F5, cyan #02BDFE, navy #01152B. New `runserv` theme (dark and light) is the default.
Old gold #C9A96E replaced by #0092F5 everywhere in mobile/src. Map background now navy. BRAND constants exported from theme.js.
Existing users who saved Onyx/Chalk keep it until they pick Runserv.

## Not done in this session
See Runserv_Pending_Work_and_Next_Steps_M9.docx.

## Update: RS pin, road path, car on the road
- RS pin (from your sheet) now marks pickup and destination on both map paths (assets/vehicles/pin_sm.png, embedded in vehicleIconData.js as MAP_ART_DATA). Pin tip is the anchor.
- Your-location dot uses the pulse-dot artwork (OpenStreetMap path).
- Road path: src/services/routing.js asks an OSRM-compatible server for the road route; src/hooks/useRoadRoute.js wraps it. Drawn in the sheet's style: white casing, solid brand-blue line, soft flowing highlight. Falls back to the old dashed straight line if routing is unavailable.
- The car sits on the road: snapToRoute() projects each GPS ping onto the route and uses the road direction as heading (ignored if more than 40 m off the road). Applied in customer ride tracking, driver active ride, customer delivery tracking and courier delivery.
- Routing server: set EXPO_PUBLIC_ROUTING_URL. The default public OSRM demo server is for development ONLY; use your own OSRM/Valhalla or a hosted provider before launch.
- Tests: routing.test.js (3) added; 8 total pass in the scratch harness.
- Not yet: route on the booking screens (RequestRide, RequestDelivery) still draws the straight line; ETA bubble and halo artwork not wired; no road-path animation of an idle demo car (movement comes from live GPS).

## Update: MapLibre chosen as the renderer
MapLibreMapView.js (RS pin, road path with casing and flow highlight, gliding vehicles, geofence circles, same ref API).
SmartMapView prefers it when the package is installed. Setup: docs/MAPLIBRE_SETUP.md. Untested on a device.
