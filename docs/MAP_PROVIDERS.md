# Map providers — switch without touching code (M14)

**Where:** Admin console → *Map provider* (SUPER_ADMIN only). Saved to the database (`SystemSettings`, key `maps.config`), audited as `map_config_changed`. Apps pick up a change within ~1 minute (at launch, on resume, and every 5 minutes), and cache the last good value for offline use.

| Setting | Options | Takes effect | Needs |
|---|---|---|---|
| Map display (renderer) | MapLibre · Google · OpenStreetMap | Instantly (remote) | **Google display needs Google keys baked into the app build** (`GOOGLE_MAPS_API_KEY_ANDROID/IOS` at EAS build time; `react-native-maps` is already a dependency). An app build without it falls back to MapLibre automatically. |
| MapLibre tile style | any https style URL | Instantly | e.g. MapTiler, Stadia, or your own tiles |
| Road routing | OSRM · Google Routes | Instantly | OSRM: set `OSRM_URL` (your own server). Google: `GOOGLE_ROUTES_API_KEY` (or the Places key) on the **server**. Routes are called through `POST /api/maps/route`, so keys never ship in the app. |
| Address search | Auto · Photon · Google Places | Instantly | Google: `GOOGLE_PLACES_API_KEY` on the server |

The admin API refuses to select Google routing/places unless the server key exists. If a key is later removed, the system degrades to OSRM/Photon rather than failing. *Test selected routing* runs a sample Lagos trip against the saved provider before you rely on it.

## Moving to Google (checklist)
1. Google Cloud: enable **Routes API**, **Places API (New)** and **Maps SDK for Android/iOS**; set billing alerts and quotas.
2. Restrict keys: server keys by IP; Android/iOS keys by app ID / bundle ID / signing certificate.
3. Server env: `GOOGLE_ROUTES_API_KEY`, `GOOGLE_PLACES_API_KEY`. Put the mobile keys in the EAS build env and ship ONE build that contains both MapLibre and Google.
4. Admin → Map provider → choose Google for routing/places → *Test* → Save. Choose Google for display last, once the Google-enabled build is in users' hands.
5. Roll back at any time by selecting MapLibre/OSRM again.
Review Google's current terms and pricing before launch (they change, and some uses restrict mixing Google data with a non-Google map).

## Before launch regardless of provider
The public OSRM demo server is development-only. Run your own (OSRM/Valhalla) and set `OSRM_URL`.
