// mobile/src/components/maplibreModule.js
// Loads @maplibre/maplibre-react-native if it is installed AND is the v11 API.
// v10 exported MapView / MarkerView / ShapeSource / FillLayer / LineLayer; v11 renamed everything:
//   MapView -> Map, MarkerView/PointAnnotation -> ViewAnnotation, ShapeSource -> GeoJSONSource,
//   FillLayer/LineLayer/SymbolLayer/CircleLayer -> Layer type="fill|line|symbol|circle".
// The old check looked for `MapView`, which v11 does not export, so MapLibre could never turn on.
let mod = null;
try { mod = require('@maplibre/maplibre-react-native'); } catch { /* not installed */ }
const candidate = mod && (mod.Map ? mod : mod.default);
export const ML = candidate && candidate.Map && candidate.Camera && candidate.ViewAnnotation && candidate.GeoJSONSource && candidate.Layer && candidate.Images
  ? candidate : null;
export const MAPLIBRE_AVAILABLE = !!ML;
