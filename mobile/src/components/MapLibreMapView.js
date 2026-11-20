// mobile/src/components/MapLibreMapView.js
// Runserv Maps renderer: MapLibre React Native v11 (maplibre.org), per the Maps & Live Tracking guide.
// Same interface as OsmMapView, so SmartMapView and every screen keep working unchanged.
//
// v11 API used here (checked against @maplibre/maplibre-react-native 11.5.1):
//   Map (was MapView) · Camera (ref.easeTo / fitBounds) · ViewAnnotation (was MarkerView) · GeoJSONSource (was ShapeSource)
//   Layer type="line|fill|symbol|circle" with `paint` / `layout` (the `style` prop is deprecated) · Images · UserLocation.
//   Coordinates are [lng, lat]; bounds are [west, south, east, north]; press events carry `lngLat`.
//
// What is drawn where:
//   • Route, geofence circles and NEARBY vehicles  -> GeoJSON layers (nearby = one symbol layer with clustering, so a
//     hundred cars are one native layer, not a hundred React views).
//   • The ASSIGNED vehicle and the RS pins          -> ViewAnnotation (AnimatedVehicle glides between real GPS fixes).
//
// MapLibre is a RENDERER: tiles come from the style below (EXPO_PUBLIC_MAP_STYLE_URL), routing from src/services/routing.js.
// The default style uses the public OpenStreetMap tile server, which is for DEVELOPMENT ONLY (OSM tile usage policy).
// Use a hosted tile provider or your own tiles for launch. The OSM attribution stays visible (attribution is on).
import React, {
  Children, forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState,
} from 'react';
import { View, StyleSheet, Image } from 'react-native';
import { ML, MAPLIBRE_AVAILABLE } from './maplibreModule';
import AnimatedVehicle from './AnimatedVehicle';
import { MAP_ART_DATA } from '../utils/vehicleIconData';
import { resolveVehicleIconKey, VEHICLE_ICON_SOURCES, VEHICLE_ICON_SIZE } from '../utils/vehicleIcons';

import { getMapConfig } from '../services/mapConfig';
export { MAPLIBRE_AVAILABLE };

const ENV_STYLE_URL = process.env.EXPO_PUBLIC_MAP_STYLE_URL || null;
const DEV_RASTER_STYLE = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

const BLUE = '#0092F5';
const NAVY = '#01152B';
const ICON_PX = 256;                       // the vehicle PNGs are 256 px; symbol icon-size is a ratio of that
const NEARBY_IMAGES = VEHICLE_ICON_SOURCES; // stable module-level object: <Images> must not get a new object every render

const zoomFromDelta = (d) => Math.max(3, Math.min(18, Math.log2(360 / (d || 0.05))));

/** v11 view state -> the react-native-maps style region the rest of the app expects. */
export const viewStateToRegion = (vs) => {
  if (!vs?.center) return null;
  const b = vs.bounds;
  return {
    latitude: vs.center[1], longitude: vs.center[0],
    latitudeDelta: b ? Math.abs(b[3] - b[1]) : 0.05,
    longitudeDelta: b ? Math.abs(b[2] - b[0]) : 0.05,
  };
};

/** Bounds [west, south, east, north] of a list of { latitude, longitude }; null for an empty list. */
export const boundsOf = (coords) => {
  const pts = (coords || []).filter((c) => Number.isFinite(c?.latitude) && Number.isFinite(c?.longitude));
  if (!pts.length) return null;
  const lats = pts.map((c) => c.latitude), lngs = pts.map((c) => c.longitude);
  return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
};

export function circlePolygon(lat, lng, radiusM, steps = 48) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    const dLat = (radiusM * Math.cos(a)) / 111320;
    const dLng = (radiusM * Math.sin(a)) / (111320 * Math.cos((lat * Math.PI) / 180));
    pts.push([lng + dLng, lat + dLat]);
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [pts] } };
}

/** GeoJSON for the nearby-vehicle layer. One feature per pin; `icon` is an <Images> key, `heading` rotates it. */
export function nearbyFeatures(pins, selectedId) {
  return {
    type: 'FeatureCollection',
    features: (pins || [])
      .filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng))
      .map((p) => {
        const key = p.vehicleType ? resolveVehicleIconKey(p.vehicleType, p) : 'car_blue';
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
          properties: {
            id: String(p.id), icon: key, heading: Number.isFinite(p.heading) ? p.heading : 0,
            size: (VEHICLE_ICON_SIZE[key] || 54) / ICON_PX, label: p.label || '',
            selected: String(p.id) === String(selectedId) ? 1 : 0,
          },
        };
      }),
  };
}

function collect(children) {
  const markers = [], polylines = [], circles = [];
  Children.forEach(children, (child) => {
    if (!child) return;
    const type = child.type?.displayName ?? child.type?.name ?? '';
    const p = child.props || {};
    if (type === 'OsmMarker' && p.coordinate?.latitude != null) markers.push(p);
    if (type === 'OsmPolyline' && Array.isArray(p.coordinates) && p.coordinates.length >= 2) polylines.push(p);
    if (type === 'OsmCircle' && p.center?.latitude != null) circles.push(p);
  });
  return { markers, polylines, circles };
}

const MapLibreMapView = forwardRef(function MapLibreMapView(
  { children, initialRegion, showsUserLocation, onMapReady, onRegionChange, onRegionChangeComplete, onPress, onMarkerPress, style },
  ref,
) {
  const cameraRef = useRef(null);
  const [pins, setPins] = useState({ list: [], selectedId: null });
  const [extraCircles, setExtraCircles] = useState([]);
  const [tracked, setTracked] = useState({});

  const { markers, polylines, circles } = useMemo(() => collect(children), [children]);
  const nearby = useMemo(() => nearbyFeatures(pins.list, pins.selectedId), [pins]);

  useImperativeHandle(ref, () => ({
    animateToRegion(region, duration = 600) {
      cameraRef.current?.easeTo({
        center: [region.longitude, region.latitude],
        zoom: zoomFromDelta(region.longitudeDelta),
        duration,
      });
    },
    fitToCoordinates(coords, options = {}) {
      const b = boundsOf(coords);
      if (!b) return;
      const pad = options.edgePadding || {};
      if (b[0] === b[2] && b[1] === b[3]) {                       // one point: fitBounds would zoom to the maximum
        cameraRef.current?.easeTo({ center: [b[0], b[1]], zoom: 16, duration: 600 });
        return;
      }
      cameraRef.current?.fitBounds(b, {
        padding: { top: pad.top ?? 60, right: pad.right ?? 60, bottom: pad.bottom ?? 60, left: pad.left ?? 60 },
        duration: 600,
      });
    },
    startRadar() { /* radar pulse rings are not ported (see docs/MAPLIBRE_SETUP.md) */ },
    stopRadar() {},
    /** Nearby vehicles: [{ id, lat, lng, heading?, vehicleType?, colour?, cargo?, label? }]. Approximate positions only. */
    setDriverPins(list, selectedId) { setPins({ list: list || [], selectedId: selectedId ?? null }); },
    setCircles(list) { setExtraCircles(list || []); },
    /**
     * The ASSIGNED vehicle. Pass real fixes only: opts = { vehicleType, cargo, colour, heading, speed, accuracy, timestamp(ms), color, label, staleLabel }.
     * The vehicle glides between fixes, turns with the road and dims with a "last seen" label when the fixes stop.
     */
    updateTrackedMarker(id, lat, lng, opts = {}) {
      const vehicleKey = opts.vehicleType ? resolveVehicleIconKey(opts.vehicleType, opts) : null;
      setTracked((cur) => ({
        ...cur,
        [id]: {
          fix: { lat, lng, heading: opts.heading, speed: opts.speed, accuracy: opts.accuracy, timestamp: opts.timestamp },
          vehicleKey, color: opts.color, label: opts.label, staleLabel: opts.staleLabel,
        },
      }));
    },
    removeTrackedMarker(id) {
      setTracked((cur) => { if (!(id in cur)) return cur; const n = { ...cur }; delete n[id]; return n; });
    },
  }), []);

  const handleRegionChange = useCallback((e) => {
    const r = viewStateToRegion(e?.nativeEvent);
    if (r) onRegionChange?.(r);
  }, [onRegionChange]);
  const handleRegionDone = useCallback((e) => {
    const r = viewStateToRegion(e?.nativeEvent);
    if (r) onRegionChangeComplete?.(r, { userInteraction: !!e?.nativeEvent?.userInteraction });
  }, [onRegionChangeComplete]);
  const handlePress = useCallback((e) => {
    const ll = e?.nativeEvent?.lngLat;
    if (ll) onPress?.({ nativeEvent: { coordinate: { latitude: ll[1], longitude: ll[0] } } });
  }, [onPress]);
  const handleNearbyPress = useCallback((e) => {
    const f = e?.nativeEvent?.features?.find((x) => x?.properties?.id != null);
    if (f) onMarkerPress?.(f.properties.id);
  }, [onMarkerPress]);

  if (!ML) return null;   // SmartMapView only picks this renderer when MAPLIBRE_AVAILABLE, so this is just a guard

  const start = initialRegion || { latitude: 6.5244, longitude: 3.3792, latitudeDelta: 0.05, longitudeDelta: 0.05 };
  const allCircles = [
    ...circles.map((c) => ({ lat: c.center.latitude, lng: c.center.longitude, radius: c.radius ?? 300, stroke: c.strokeColor, fill: c.fillColor, w: c.strokeWidth })),
    ...extraCircles.map((c) => ({ lat: c.lat, lng: c.lng, radius: c.radius, stroke: c.strokeColor, fill: c.fillColor, w: c.strokeWidth })),
  ];
  const hasNearby = nearby.features.length > 0;
  const STYLE_URL = getMapConfig().styleUrl || ENV_STYLE_URL; // M14: tile style can be changed remotely (https only)
  const hasGlyphs = !!STYLE_URL;      // cluster count text needs a style with glyphs; the dev raster style has none

  return (
    <View style={[st.root, style]}>
      <ML.Map
        style={StyleSheet.absoluteFill}
        mapStyle={STYLE_URL || DEV_RASTER_STYLE}
        logo={false}
        attribution
        attributionPosition={{ bottom: 6, left: 6 }}
        compass={false}
        touchRotate={false}
        touchPitch={false}
        onDidFinishLoadingMap={() => onMapReady?.()}
        onRegionIsChanging={handleRegionChange}
        onRegionDidChange={handleRegionDone}
        onPress={handlePress}
      >
        <ML.Camera
          ref={cameraRef}
          initialViewState={{ center: [start.longitude, start.latitude], zoom: zoomFromDelta(start.longitudeDelta) }}
        />

        {allCircles.map((c, i) => (
          <ML.GeoJSONSource key={`c${i}`} id={`circle-src-${i}`} data={circlePolygon(c.lat, c.lng, c.radius)}>
            <ML.Layer id={`circle-fill-${i}`} type="fill" source={`circle-src-${i}`} paint={{ 'fill-color': c.fill || 'rgba(0,146,245,0.06)' }} />
            <ML.Layer id={`circle-line-${i}`} type="line" source={`circle-src-${i}`} paint={{ 'line-color': c.stroke || 'rgba(0,146,245,0.5)', 'line-width': c.w || 1.5 }} />
          </ML.GeoJSONSource>
        ))}

        {polylines.map((p, i) => {
          const w = p.strokeWidth ?? 3;
          const road = !p.lineDashPattern && w >= 5;        // road-following route: white edge, solid blue, soft highlight
          const src = `route-src-${i}`;
          const data = {
            type: 'Feature', properties: {},
            geometry: { type: 'LineString', coordinates: p.coordinates.map((c) => [c.longitude, c.latitude]) },
          };
          return (
            <ML.GeoJSONSource key={`l${i}`} id={src} data={data}>
              {road ? (
                <ML.Layer id={`route-casing-${i}`} type="line" source={src}
                  layout={{ 'line-cap': 'round', 'line-join': 'round' }}
                  paint={{ 'line-color': '#FFFFFF', 'line-width': w + 5 }} />
              ) : null}
              <ML.Layer id={`route-line-${i}`} type="line" source={src}
                layout={{ 'line-cap': p.lineDashPattern ? 'butt' : 'round', 'line-join': 'round' }}
                paint={{ 'line-color': p.strokeColor || BLUE, 'line-width': w, ...(p.lineDashPattern ? { 'line-dasharray': [2, 1.5] } : {}) }} />
              {road ? (
                <ML.Layer id={`route-flow-${i}`} type="line" source={src}
                  layout={{ 'line-cap': 'round' }}
                  paint={{ 'line-color': '#7FD6FF', 'line-width': Math.max(2, w - 3), 'line-dasharray': [0.2, 2.2] }} />
              ) : null}
            </ML.GeoJSONSource>
          );
        })}

        {/* Nearby vehicles: one clustered symbol layer. Positions are the server's rounded (~110 m) ones. */}
        {hasNearby ? (
          <>
            <ML.Images images={NEARBY_IMAGES} />
            <ML.GeoJSONSource id="nearby-src" data={nearby} cluster clusterRadius={44} clusterMaxZoom={15} onPress={handleNearbyPress}>
              <ML.Layer id="nearby-clusters" type="circle" source="nearby-src" filter={['has', 'point_count']}
                paint={{
                  'circle-color': NAVY, 'circle-stroke-color': BLUE, 'circle-stroke-width': 2,
                  'circle-radius': ['step', ['get', 'point_count'], 15, 5, 19, 20, 25],
                }} />
              {hasGlyphs ? (
                <ML.Layer id="nearby-cluster-count" type="symbol" source="nearby-src" filter={['has', 'point_count']}
                  layout={{ 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12, 'text-allow-overlap': true }}
                  paint={{ 'text-color': '#FFFFFF' }} />
              ) : null}
              <ML.Layer id="nearby-halo" type="circle" source="nearby-src" filter={['all', ['!', ['has', 'point_count']], ['==', ['get', 'selected'], 1]]}
                paint={{ 'circle-radius': 28, 'circle-color': 'rgba(0,146,245,0.18)', 'circle-stroke-color': BLUE, 'circle-stroke-width': 2 }} />
              <ML.Layer id="nearby-vehicles" type="symbol" source="nearby-src" filter={['!', ['has', 'point_count']]}
                layout={{
                  'icon-image': ['get', 'icon'], 'icon-size': ['get', 'size'], 'icon-rotate': ['get', 'heading'],
                  'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true,
                }} />
            </ML.GeoJSONSource>
          </>
        ) : null}

        {/* RS pin marks the spot; the tip is the bottom-centre of the artwork */}
        {markers.map((m, i) => (
          <ML.ViewAnnotation key={`pin${i}`} id={`pin-${i}`} lngLat={[m.coordinate.longitude, m.coordinate.latitude]} anchor="bottom" onPress={m.onPress}>
            <View>
              {m.children || (
                <Image source={require('../../assets/vehicles/pin_sm.png')}
                  style={{ width: MAP_ART_DATA.pin.w, height: MAP_ART_DATA.pin.h }} resizeMode="contain" />
              )}
            </View>
          </ML.ViewAnnotation>
        ))}

        {/* The assigned vehicle: real fixes only, glides + turns, dims when the fixes stop */}
        {Object.entries(tracked).map(([id, t]) => (
          <AnimatedVehicle key={`veh${id}`} id={`veh-${id}`} fix={t.fix} vehicleKey={t.vehicleKey} color={t.color} label={t.label} staleLabel={t.staleLabel} />
        ))}

        {showsUserLocation ? <ML.UserLocation animated accuracy /> : null}
      </ML.Map>
    </View>
  );
});

MapLibreMapView.displayName = 'MapLibreMapView';
export default MapLibreMapView;

const st = StyleSheet.create({
  root: { overflow: 'hidden', backgroundColor: '#071426' },
});
