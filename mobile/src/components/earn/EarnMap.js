// mobile/src/components/earn/EarnMap.js
//
// The drawn Runserv city map (same look as the customer's Trip Preview: no tiles, no API key, no GPS, instant) for the
// signed-out Driver and Courier previews.
//
//   variant="DRIVER"   a vehicle cruises a loop of streets while ride REQUESTS pop up around it as little fare chips.
//                      `share` (0..1) sets how often they come: ask for a higher price and fewer pop up.
//   variant="COURIER"  a parcel run: pickup box -> drop-off pin. The route stretches with the distance, and the courier's
//                      vehicle (cargo artwork) drives it, then starts the next run.
//
// Everything animated runs on the native driver; reduced-motion shows a still frame.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Animated, Easing, StyleSheet } from 'react-native';
import Svg, { Rect, Line, Polyline, Circle, Path } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import { BRAND } from '../../theme/theme';
import { resolveVehicleIconKey, vehicleIconSource } from '../../utils/vehicleIcons';
import { useReduceMotion } from './EarnKit';

// ── geometry shared with the customer's TripPreviewMap (same streets, so the family resemblance is exact) ──
const STREETS_H = [0.16, 0.36, 0.62, 0.90];
const STREETS_V = [0.18, 0.44, 0.72, 0.92];
const BLOCKS = [
  [0.04, 0.04, 0.20, 0.10], [0.50, 0.05, 0.15, 0.12], [0.76, 0.40, 0.14, 0.16],
  [0.06, 0.40, 0.10, 0.18], [0.48, 0.66, 0.18, 0.14], [0.76, 0.68, 0.16, 0.12],
];
// The courier route (same winding route as the customer's trip preview).
const ROUTE = [
  [0.12, 0.84], [0.30, 0.74], [0.34, 0.54], [0.56, 0.47],
  [0.60, 0.28], [0.82, 0.23], [0.90, 0.11],
];
// A loop that stays on streets: every vertex is a street crossing.
const LOOP = [
  [0.18, 0.62], [0.18, 0.16], [0.72, 0.16], [0.72, 0.62], [0.44, 0.62], [0.44, 0.90], [0.18, 0.90], [0.18, 0.62],
];
// Street crossings (not on the loop) where requests appear.
const PING_SPOTS = [
  [0.92, 0.36], [0.72, 0.90], [0.44, 0.36], [0.92, 0.16], [0.18, 0.36], [0.72, 0.36], [0.92, 0.62], [0.44, 0.16],
];

export const MIN_RUN_KM = 1;
export const MAX_RUN_KM = 30;
export const kmToFraction = (km) => 0.24 + 0.76 * ((Math.min(MAX_RUN_KM, Math.max(MIN_RUN_KM, km)) - MIN_RUN_KM) / (MAX_RUN_KM - MIN_RUN_KM));

const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

/** The first `fraction` of the courier route, in pixels. */
export function routeUpTo(fraction, w, h) {
  const full = ROUTE.map(([x, y]) => ({ x: x * w, y: y * h }));
  const total = full.reduce((acc, p, i) => (i ? acc + dist(full[i - 1], p) : 0), 0);
  const target = total * fraction;
  const out = [full[0]];
  let run = 0;
  for (let i = 1; i < full.length; i += 1) {
    const a = full[i - 1], b = full[i];
    const seg = dist(a, b);
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

/**
 * Turn a polyline into Animated interpolation inputs. At each corner the vehicle turns QUICKLY (over a sliver of the
 * trip) instead of drifting round the whole street. Pure, so it can be unit-tested.
 * @returns {{ input:number[], xs:number[], ys:number[], rot:number[], total:number }}
 */
export function buildMotion(pts, turn = 0.012) {
  const cum = [0];
  for (let i = 1; i < pts.length; i += 1) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  const total = cum[cum.length - 1] || 1;
  const input = [], xs = [], ys = [], rot = [];
  let prev = null;
  const heading = (i) => {
    const a = pts[i], b = pts[i + 1];
    let d = (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180) / Math.PI; // 0° = north: the artwork faces north
    if (prev !== null) { while (d - prev > 180) d -= 360; while (d - prev < -180) d += 360; }
    prev = d;
    return d;
  };
  const push = (t, p, d) => {
    const tt = Math.min(1, Math.max(0, t));
    if (input.length && tt <= input[input.length - 1]) return; // inputRange must be strictly increasing
    input.push(tt); xs.push(p.x); ys.push(p.y); rot.push(d);
  };
  const headings = [];
  for (let i = 0; i < pts.length - 1; i += 1) headings.push(heading(i));
  for (let i = 0; i < pts.length - 1; i += 1) {
    const t0 = cum[i] / total;
    // arrive at this corner facing the previous heading, leave it facing the next one
    if (i > 0) push(t0 - turn / 2, pts[i], headings[i - 1]);
    push(i > 0 ? t0 + turn / 2 : t0, pts[i], headings[i]);
  }
  push(1, pts[pts.length - 1], headings[headings.length - 1]);
  return { input, xs, ys, rot, total };
}

export const cityPalette = (theme, dark) => ({
  bg: theme.backgroundAlt,
  street: dark ? '#13264A' : '#E3ECF8',
  road: dark ? '#1C3764' : '#FFFFFF',
  block: dark ? '#0F2040' : '#E8F1FC',
  water: BRAND.cyan,
});

function Backdrop({ width, height, pal, dark }) {
  return (
    <>
      {BLOCKS.map(([x, y, w, h], i) => (
        <Rect key={`b${i}`} x={x * width} y={y * height} width={w * width} height={h * height} rx={8} fill={pal.block} />
      ))}
      <Path d={`M${width * 0.0},${height * 0.58} C${width * 0.12},${height * 0.5} ${width * 0.1},${height * 0.7} ${width * 0.2},${height * 0.66} L${width * 0.2},${height * 0.98} L0,${height * 0.98} Z`} fill={pal.water} opacity={dark ? 0.10 : 0.16} />
      {STREETS_H.map((y, i) => <Line key={`h${i}`} x1={0} x2={width} y1={y * height} y2={y * height} stroke={i % 2 ? pal.street : pal.road} strokeWidth={i % 2 ? 6 : 10} />)}
      {STREETS_V.map((x, i) => <Line key={`v${i}`} y1={0} y2={height} x1={x * width} x2={x * width} stroke={i % 2 ? pal.road : pal.street} strokeWidth={i % 2 ? 10 : 6} />)}
      <Line x1={0} y1={height * 0.2} x2={width * 0.5} y2={height} stroke={pal.road} strokeWidth={7} />
      <Line x1={width * 0.5} y1={0} x2={width} y2={height * 0.55} stroke={pal.road} strokeWidth={7} />
    </>
  );
}

/** A vehicle that follows `motion` forever (or sits still when `still`). */
function Rider({ motion, size, source, duration, still, start }) {
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    progress.setValue(0);
    if (still || motion.input.length < 2) return undefined;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(progress, { toValue: 1, duration, easing: Easing.linear, useNativeDriver: true }),
      Animated.delay(500),
    ]));
    loop.start();
    return () => loop.stop();
  }, [motion, duration, still, progress]);

  const ready = motion.input.length >= 2;
  const tx = ready ? progress.interpolate({ inputRange: motion.input, outputRange: motion.xs.map((x) => x - size / 2) }) : start.x - size / 2;
  const ty = ready ? progress.interpolate({ inputRange: motion.input, outputRange: motion.ys.map((y) => y - size / 2) }) : start.y - size / 2;
  const rotate = ready ? progress.interpolate({ inputRange: motion.input, outputRange: motion.rot.map((d) => `${d}deg`) }) : '0deg';
  return (
    <Animated.Image
      source={source}
      resizeMode="contain"
      style={{ position: 'absolute', left: 0, top: 0, width: size, height: size, transform: [{ translateX: tx }, { translateY: ty }, { rotate }] }}
    />
  );
}

/** One request chip: a ring that ripples out and a fare that floats up and fades. */
function Ping({ x, y, label, color, onDone, still }) {
  const a = useRef(new Animated.Value(0)).current;
  const done = useRef(onDone);
  done.current = onDone; // the parent re-renders on every spawn: keep the latest callback without restarting the animation
  useEffect(() => {
    if (still) { a.setValue(0.45); return undefined; }
    const anim = Animated.timing(a, { toValue: 1, duration: 2100, easing: Easing.out(Easing.quad), useNativeDriver: true });
    anim.start(({ finished }) => { if (finished) done.current?.(); });
    return () => anim.stop();
  }, [a, still]);
  const ring = a.interpolate({ inputRange: [0, 1], outputRange: [0.3, 2.6] });
  const ringO = a.interpolate({ inputRange: [0, 0.7, 1], outputRange: [0.55, 0.15, 0] });
  const chipO = a.interpolate({ inputRange: [0, 0.12, 0.75, 1], outputRange: [0, 1, 1, 0] });
  const chipY = a.interpolate({ inputRange: [0, 1], outputRange: [0, -22] });
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: x - 40, top: y - 40, width: 80, height: 80, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={{ position: 'absolute', width: 30, height: 30, borderRadius: 15, borderWidth: 2, borderColor: color, backgroundColor: color + '33', opacity: ringO, transform: [{ scale: ring }] }} />
      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color, borderWidth: 2, borderColor: '#FFFFFF' }} />
      <Animated.View style={[st.chip, { backgroundColor: color, opacity: chipO, transform: [{ translateY: chipY }] }]}>
        <Text style={st.chipTxt}>{label}</Text>
      </Animated.View>
    </View>
  );
}

export default function EarnMap({
  variant = 'DRIVER', width, height, theme, mode,
  vehicleType = 'CAR', cargo = false, accent,
  share = 1, pingLabel = '', // DRIVER
  km = 6, label = '',        // COURIER
}) {
  const dark = mode === 'dark';
  const pal = useMemo(() => cityPalette(theme, dark), [theme, dark]);
  const reduce = useReduceMotion();
  const color = accent || theme.accent;
  const isDriver = variant === 'DRIVER';

  // ── DRIVER: loop + pings ───────────────────────────────────────────────────
  const loopPts = useMemo(() => LOOP.map(([x, y]) => ({ x: x * width, y: y * height })), [width, height]);
  const routePts = useMemo(() => routeUpTo(kmToFraction(km), width, height), [km, width, height]);
  const pts = isDriver ? loopPts : routePts;
  const motion = useMemo(() => buildMotion(pts), [pts]);
  const lengthPx = motion.total;
  // constant speed on the loop; the courier's trip takes longer the longer the route
  const duration = isDriver ? Math.max(9000, lengthPx * 16) : 2600 + lengthPx * 6;

  const iconKey = resolveVehicleIconKey(vehicleType, { colour: 'blue', cargo });
  const SZ = vehicleType === 'VAN' ? 46 : vehicleType === 'MOTORCYCLE' ? 40 : 42;

  const [pings, setPings] = useState([]);
  const nextId = useRef(1);
  const spotRef = useRef(0);
  useEffect(() => {
    if (!isDriver) { setPings([]); return undefined; }
    if (reduce) { // one still frame so the idea reads without motion
      const [x, y] = PING_SPOTS[0];
      setPings([{ id: 0, x: x * width, y: y * height }]);
      return undefined;
    }
    const every = 1500 / Math.max(0.3, share); // fewer requests at a higher ask: the gap between pings stretches
    const spawn = () => {
      const [x, y] = PING_SPOTS[spotRef.current % PING_SPOTS.length];
      spotRef.current += 3; // 3 is coprime with 8: visits every spot before repeating
      setPings((p) => [...p.slice(-3), { id: nextId.current++, x: x * width, y: y * height }]);
    };
    spawn();
    const iv = setInterval(spawn, every);
    return () => clearInterval(iv);
  }, [isDriver, share, width, height, reduce]);

  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduce) return undefined;
    const l = Animated.loop(Animated.timing(pulse, { toValue: 1, duration: 1800, easing: Easing.out(Easing.quad), useNativeDriver: true }));
    l.start();
    return () => l.stop();
  }, [pulse, reduce]);
  const pulseScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.6, 2.4] });
  const pulseOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] });

  const start = pts[0];
  const end = pts[pts.length - 1];
  const polyline = pts.map((p) => `${p.x},${p.y}`).join(' ');

  return (
    <View style={[st.wrap, { width, height, backgroundColor: pal.bg, borderColor: theme.border }]}>
      <Svg width={width} height={height}>
        <Backdrop width={width} height={height} pal={pal} dark={dark} />
        {/* the route / loop: soft glow, solid line, dotted centre */}
        <Polyline points={polyline} fill="none" stroke={color} strokeOpacity={isDriver ? 0.14 : 0.2} strokeWidth={14} strokeLinejoin="round" strokeLinecap="round" />
        <Polyline points={polyline} fill="none" stroke={color} strokeOpacity={isDriver ? 0.55 : 1} strokeWidth={isDriver ? 4 : 5} strokeLinejoin="round" strokeLinecap="round" />
        <Polyline points={polyline} fill="none" stroke={BRAND.cyan} strokeWidth={1.6} strokeDasharray="1 9" strokeLinecap="round" />
        {!isDriver && <Circle cx={start.x} cy={start.y} r={7} fill="#FFFFFF" stroke={color} strokeWidth={3} />}
      </Svg>

      {isDriver ? (
        pings.map((p) => (
          <Ping key={p.id} x={p.x} y={p.y} label={pingLabel} color={color} still={reduce}
            onDone={() => setPings((all) => all.filter((q) => q.id !== p.id))} />
        ))
      ) : (
        <>
          {/* pickup: a parcel waiting */}
          {!reduce && <Animated.View pointerEvents="none" style={[st.pulse, { left: start.x - 14, top: start.y - 14, backgroundColor: color, opacity: pulseOpacity, transform: [{ scale: pulseScale }] }]} />}
          <View pointerEvents="none" style={[st.box, { left: start.x - 13, top: start.y - 13, backgroundColor: color }]}>
            <Ionicons name="cube" size={15} color="#1A1000" />
          </View>
          {/* drop-off pin + distance bubble */}
          <View pointerEvents="none" style={[st.pinWrap, { left: end.x - 20, top: end.y - 46 }]}>
            <View style={[st.bubble, { backgroundColor: color }]}><Text style={st.bubbleTxt}>{label}</Text></View>
            <Ionicons name="location" size={30} color={color} style={{ marginTop: -3 }} />
          </View>
        </>
      )}

      <Rider motion={motion} size={SZ} source={vehicleIconSource(iconKey)} duration={duration} still={reduce} start={start} />
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { borderRadius: 24, borderWidth: 1, overflow: 'hidden' },
  pulse: { position: 'absolute', width: 28, height: 28, borderRadius: 14 },
  box: { position: 'absolute', width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#FFFFFF' },
  pinWrap: { position: 'absolute', width: 40, alignItems: 'center' },
  bubble: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 9, minWidth: 44, alignItems: 'center' },
  bubbleTxt: { color: '#1A1000', fontSize: 11, fontWeight: '800', letterSpacing: 0.2 },
  chip: { position: 'absolute', top: 2, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 9 },
  chipTxt: { color: '#03170F', fontSize: 11, fontWeight: '800' },
});
