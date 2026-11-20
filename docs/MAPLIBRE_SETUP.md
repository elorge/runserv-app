# MapLibre setup (v11)
1. `cd mobile && npm install` (adds `@maplibre/maplibre-react-native@11.5.1`; commit the generated lockfile).
2. `app.config.js` already lists the plugin. MapLibre is native code: build a **development client** (`npx expo prebuild` / `eas build --profile development`). Expo Go cannot load it; the app then falls back to the older map automatically.
3. Optional: `EXPO_PUBLIC_MAP_STYLE_URL` = a hosted style JSON (with glyphs, so cluster counts show). Without it the app uses the public OpenStreetMap tiles, **for development only**; use a hosted provider for launch. Keep the attribution visible.
4. Backend: run `backend/prisma/sql/m10_location_consent.sql` on existing databases, then `npx prisma generate`.
5. v11 names: `Map` (was MapView), `ViewAnnotation` (was MarkerView), `GeoJSONSource` (was ShapeSource), `Layer type=...` with `paint`/`layout`.
