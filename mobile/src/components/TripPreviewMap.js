// mobile/src/components/TripPreviewMap.js
//
// A stylised Runserv city map for the signed-out Trip Preview. It is drawn, not downloaded:
// no tiles, no API key, no location permission, instant on first launch. The route stretches
// as the visitor changes the distance, and the chosen vehicle (real Runserv artwork) drives it.
import React, { useEffect, useMemo, useRef } from 'react';
import { View, Text, Animated, Easing, StyleSheet } from 'react-native';
import Svg, { Rect, Line, Polyline, Circle, Path } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import { BRAND } from '../theme/theme';
import { resolveVehicleIconKey, vehicleIconSource } from '../utils/vehicleIcons';

// A winding route across the map, normalised 0..1 (origin bottom-left → far end top-right).
const ROUTE = [
  [0.12, 0.84], [0.30, 0.74], [0.34, 0.54], [0.56, 0.47],
  [0.60, 0.28], [0.82, 0.23], [0.90, 0.11],
];
const STREETS_H = [0.16, 0.36, 0.62, 0.90];
const STREETS_V = [0.18, 0.44, 0.72, 0.92];
const BLOCKS = [
  [0.04, 0.04, 0.20, 0.10], [0.50, 0.05, 0.15, 0.12], [0.76, 0.40, 0.14, 0.16],
  [0.06, 0.40, 0.10, 0.18], [0.48, 0.66, 0.18, 0.14], [0.76, 0.68, 0.16, 0.12],
];

export const MIN_KM = 1;
export const MAX_KM = 30;

const lengthOf = (pts) => pts.reduce((acc, p, i) => (i ? acc + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) : 0), 0);

/** The first `fraction` of the route, in pixels. */
function routeUpTo(fraction, w, h) {
  const full = ROUTE.map(([x, y]) => ({ x: x * w, y: y * h }));
  const target = lengthOf(full) * fraction;
  const out = [full[0]];
  let run = 0;
  for (let i = 1; i < full.length; i += 1) {
    const a = full[i - 1], b = full[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (run + seg >= target) {
      const k = seg === 0 ? 0 : (target - run) / seg;
      out.push({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
      return out;
    }
    out.push(b);
    run += seg;
  }
  return out;
}

export const kmToFraction = (km) => 0.24 + 0.76 * ((Math.min(MAX_KM, Math.max(MIN_KM, km)) - MIN_KM) / (MAX_KM - MIN_KM));

export default function TripPreviewMap({ width, height, km, vehicleType = 'CAR', theme, mode, label }) {
  const dark = mode === 'dark';
  const pal = {
    bg:     theme.backgroundAlt,
    street: dark ? '#13264A' : '#E3ECF8',
    road:   dark ? '#1C3764' : '#FFFFFF',
    block:  dark ? '#0F2040' : '#E8F1FC',
    water:  BRAND.cyan,
  };

  const pts = useMemo(() => routeUpTo(kmToFraction(km), width, height), [km, width, height]);
  const end = pts[pts.length - 1];
  const start = pts[0];

  // Vehicle path: position + heading at each vertex, normalised by distance travelled.
  const motion = useMemo(() => {
    const cum = [0];
    for (let i = 1; i < pts.length; i += 1) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    const total = cum[cum.length - 1] || 1;
    const input = [], xs = [], ys = [], rot = [];
    let prevDeg = null;
    for (let i = 0; i < pts.length; i += 1) {
      const a = pts[Math.min(i, pts.length - 2)], b = pts[Math.min(i + 1, pts.length - 1)];
      let deg = (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180) / Math.PI; // 0° = north (artwork faces north)
      if (prevDeg !== null) { while (deg - prevDeg > 180) deg -= 360; while (deg - prevDeg < -180) deg += 360; }
      prevDeg = deg;
      const t = cum[i] / total;
      if (input.length && t <= input[input.length - 1]) continue; // keep inputRange strictly increasing
      input.push(t); xs.push(pts[i].x); ys.push(pts[i].y); rot.push(deg);
    }
    return { input, xs, ys, rot, total };
  }, [pts]);

  const progress = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    progress.setValue(0);
    if (motion.input.length < 2) return undefined;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(progress, { toValue: 1, duration: 2600 + motion.total * 6, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.delay(700),
    ]));
    loop.start();
    return () => loop.stop();
  }, [motion, progress]);

  useEffect(() => {
    const l = Animated.loop(Animated.timing(pulse, { toValue: 1, duration: 1800, easing: Easing.out(Easing.quad), useNativeDriver: true }));
    l.start();
    return () => l.stop();
  }, [pulse]);

  const iconKey = resolveVehicleIconKey(vehicleType, { colour: 'blue' });
  const SZ = vehicleType === 'VAN' ? 46 : vehicleType === 'MOTORCYCLE' ? 40 : 42;
  const ready = motion.input.length >= 2;
  const tx = ready ? progress.interpolate({ inputRange: motion.input, outputRange: motion.xs.map((x) => x - SZ / 2) }) : start.x - SZ / 2;
  const ty = ready ? progress.interpolate({ inputRange: motion.input, outputRange: motion.ys.map((y) => y - SZ / 2) }) : start.y - SZ / 2;
  const rotate = ready ? progress.interpolate({ inputRange: motion.input, outputRange: motion.rot.map((d) => `${d}deg`) }) : '0deg';

  const pulseScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.6, 2.4] });
  const pulseOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] });
  const polyline = pts.map((p) => `${p.x},${p.y}`).join(' ');

  return (
    <View style={[s.wrap, { width, height, backgroundColor: pal.bg, borderColor: theme.border }]}>
      <Svg width={width} height={height}>
        {BLOCKS.map(([x, y, w, h], i) => (
          <Rect key={`b${i}`} x={x * width} y={y * height} width={w * width} height={h * height} rx={8} fill={pal.block} />
        ))}
        <Path d={`M${width * 0.0},${height * 0.58} C${width * 0.12},${height * 0.5} ${width * 0.1},${height * 0.7} ${width * 0.2},${height * 0.66} L${width * 0.2},${height * 0.98} L0,${height * 0.98} Z`} fill={pal.water} opacity={dark ? 0.10 : 0.16} />
        {STREETS_H.map((y, i) => <Line key={`h${i}`} x1={0} x2={width} y1={y * height} y2={y * height} stroke={i % 2 ? pal.street : pal.road} strokeWidth={i % 2 ? 6 : 10} />)}
        {STREETS_V.map((x, i) => <Line key={`v${i}`} y1={0} y2={height} x1={x * width} x2={x * width} stroke={i % 2 ? pal.road : pal.street} strokeWidth={i % 2 ? 10 : 6} />)}
        <Line x1={0} y1={height * 0.2} x2={width * 0.5} y2={height} stroke={pal.road} strokeWidth={7} />
        <Line x1={width * 0.5} y1={0} x2={width} y2={height * 0.55} stroke={pal.road} strokeWidth={7} />

        {/* Route: soft glow, solid line, white centre */}
        <Polyline points={polyline} fill="none" stroke={theme.accent} strokeOpacity={0.18} strokeWidth={14} strokeLinejoin="round" strokeLinecap="round" />
        <Polyline points={polyline} fill="none" stroke={theme.accent} strokeWidth={5} strokeLinejoin="round" strokeLinecap="round" />
        <Polyline points={polyline} fill="none" stroke={BRAND.cyan} strokeWidth={1.6} strokeDasharray="1 9" strokeLinecap="round" />

        <Circle cx={start.x} cy={start.y} r={7} fill="#FFFFFF" stroke={theme.accent} strokeWidth={3} />
      </Svg>

      {/* origin pulse */}
      <Animated.View pointerEvents="none" style={[s.pulse, { left: start.x - 14, top: start.y - 14, backgroundColor: theme.accent, opacity: pulseOpacity, transform: [{ scale: pulseScale }] }]} />

      {/* destination pin + distance bubble */}
      <View pointerEvents="none" style={[s.pinWrap, { left: end.x - 20, top: end.y - 46 }]}>
        <View style={[s.bubble, { backgroundColor: theme.accent }]}>
          <Text style={s.bubbleTxt}>{label}</Text>
        </View>
        <Ionicons name="location" size={30} color={theme.accent} style={{ marginTop: -3 }} />
      </View>

      {/* the vehicle, driving the route */}
      <Animated.Image
        source={vehicleIconSource(iconKey)}
        resizeMode="contain"
        style={{ position: 'absolute', left: 0, top: 0, width: SZ, height: SZ, transform: [{ translateX: tx }, { translateY: ty }, { rotate }] }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  wrap:    { borderRadius: 24, borderWidth: 1, overflow: 'hidden' },
  pulse:   { position: 'absolute', width: 28, height: 28, borderRadius: 14 },
  pinWrap: { position: 'absolute', width: 40, alignItems: 'center' },
  bubble:  { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 9, minWidth: 44, alignItems: 'center' },
  bubbleTxt: { color: '#FFFFFF', fontSize: 11, fontWeight: '800', letterSpacing: 0.2 },
});
