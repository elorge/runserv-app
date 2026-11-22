// mobile/src/components/earn/EarnViz.js
//
// Two small data drawings that make the estimates tangible:
//   WeekStrip – seven day columns. Tap a day to work it; each worked day fills to the day's earnings RANGE
//               (solid to the quiet-day figure, a translucent cap up to the busy-day figure), so a wider range is
//               literally a taller cap.
//   ShiftTape – a shift drawn as a strip of time: solid blocks are runs, pale blocks are the waiting between them.
//               More runs fit on a busy day than a quiet one, and you can see why.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Animated, Easing, TouchableOpacity, StyleSheet } from 'react-native';
import { useReduceMotion } from './EarnKit';

const hex = (c, a) => c + a; // c is #RRGGBB, a is a 2-digit hex alpha

export function WeekStrip({ days, onToggle, low, high, max, color, theme, letters, names, height = 104, interactive = true, workingLabel, restLabel }) {
  const reduce = useReduceMotion();
  const lowH = useRef(new Animated.Value(0)).current;
  const highH = useRef(new Animated.Value(0)).current;
  const on = useRef(Array.from({ length: 7 }, (_, i) => new Animated.Value(days.includes(i) ? 1 : 0))).current;

  const lowR = max > 0 ? Math.min(1, low / max) : 0;
  const highR = max > 0 ? Math.min(1, high / max) : 0;

  useEffect(() => {
    const cfg = (v, to) => (reduce
      ? Animated.timing(v, { toValue: to, duration: 0, useNativeDriver: false })
      : Animated.spring(v, { toValue: to, tension: 90, friction: 12, useNativeDriver: false }));
    const anims = [cfg(lowH, lowR * height), cfg(highH, highR * height)];
    anims.forEach((a) => a.start());
    return () => anims.forEach((a) => a.stop());
  }, [lowR, highR, height, reduce, lowH, highH]);

  useEffect(() => {
    on.forEach((v, i) => Animated.timing(v, { toValue: days.includes(i) ? 1 : 0, duration: reduce ? 0 : 220, easing: Easing.out(Easing.quad), useNativeDriver: false }).start());
  }, [days, reduce, on]);

  return (
    <View style={st.row}>
      {Array.from({ length: 7 }, (_, i) => {
        const active = days.includes(i);
        const Col = interactive ? TouchableOpacity : View;
        const colProps = interactive ? {
          activeOpacity: 0.8, onPress: () => onToggle?.(i),
          accessibilityRole: 'checkbox', accessibilityState: { checked: active },
          accessibilityLabel: `${names?.[i] ?? i}: ${active ? workingLabel : restLabel}`,
          hitSlop: { top: 6, bottom: 6, left: 2, right: 2 },
        } : {};
        return (
          <Col key={i} style={st.col} {...colProps}>
            <View style={[st.track, { height, backgroundColor: theme.pill, borderColor: active ? hex(color, '55') : theme.border }]}>
              <Animated.View style={[st.cap, { height: Animated.multiply(highH, on[i]), backgroundColor: hex(color, '38'), borderColor: hex(color, '88') }]} />
              <Animated.View style={[st.solid, { height: Animated.multiply(lowH, on[i]), backgroundColor: color }]} />
            </View>
            <Text style={[st.letter, { color: active ? color : theme.hint, fontWeight: active ? '900' : '600' }]}>{letters?.[i]}</Text>
          </Col>
        );
      })}
    </View>
  );
}

/** Pure: lay a shift out as run / wait blocks, in minutes. Exported for tests. */
export function tapeSegments({ shiftMin, runMin, gapMin }) {
  const segs = [];
  if (!(shiftMin > 0) || !(runMin > 0)) return segs;
  let t = 0;
  while (t + runMin <= shiftMin + 1e-9 && segs.length < 80) {
    segs.push({ kind: 'run', min: runMin }); t += runMin;
    const g = Math.min(gapMin, shiftMin - t);
    if (g > 0.01) { segs.push({ kind: 'gap', min: g }); t += g; }
  }
  if (shiftMin - t > 0.01) segs.push({ kind: 'spare', min: shiftMin - t });
  return segs;
}

export function ShiftTape({ shiftMin, runMin, gapMin, color, theme, title, count, countLabel }) {
  const reduce = useReduceMotion();
  const segs = useMemo(() => tapeSegments({ shiftMin, runMin, gapMin }), [shiftMin, runMin, gapMin]);
  const [w, setW] = useState(0);
  const reveal = useRef(new Animated.Value(0)).current;
  const sig = `${shiftMin}|${runMin}|${Math.round(gapMin * 10)}`;
  useEffect(() => {
    reveal.setValue(reduce ? 1 : 0);
    if (reduce) return undefined;
    const a = Animated.timing(reveal, { toValue: 1, duration: 650, easing: Easing.out(Easing.cubic), useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [sig, reveal, reduce]);
  const x = reveal.interpolate({ inputRange: [0, 1], outputRange: [-w, 0] });

  return (
    <View style={{ marginTop: 10 }}>
      <View style={st.tapeHead}>
        <Text style={[st.tapeTitle, { color: theme.hint }]}>{title}</Text>
        <Text style={[st.tapeCount, { color: theme.foreground }]}>
          {count} <Text style={{ color: theme.hint, fontWeight: '600', fontSize: 12 }}>{countLabel}</Text>
        </Text>
      </View>
      <View style={[st.tape, { backgroundColor: theme.pill, borderColor: theme.border }]} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
        <Animated.View style={[st.tapeInner, { transform: [{ translateX: x }] }]}>
          {segs.map((s, i) => (
            <View
              key={i}
              style={{
                width: `${(s.min / shiftMin) * 100}%`, height: '100%',
                backgroundColor: s.kind === 'run' ? color : s.kind === 'gap' ? hex(color, '2A') : 'transparent',
                borderRightWidth: s.kind === 'run' ? 1.5 : 0, borderRightColor: theme.pill,
              }}
            />
          ))}
        </Animated.View>
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  row: { flexDirection: 'row', gap: 6 },
  col: { flex: 1, alignItems: 'center' },
  track: { width: '100%', borderRadius: 12, borderWidth: 1, justifyContent: 'flex-end', overflow: 'hidden' },
  cap: { position: 'absolute', bottom: 0, left: 0, right: 0, borderTopWidth: 1.5, borderRadius: 11 },
  solid: { width: '100%', borderBottomLeftRadius: 11, borderBottomRightRadius: 11, borderTopLeftRadius: 4, borderTopRightRadius: 4 },
  letter: { marginTop: 6, fontSize: 12 },
  tapeHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 },
  tapeTitle: { fontSize: 10, fontWeight: '800', letterSpacing: 2 },
  tapeCount: { fontSize: 18, fontWeight: '800' },
  tape: { height: 24, borderRadius: 9, borderWidth: 1, overflow: 'hidden' },
  tapeInner: { flexDirection: 'row', height: '100%', width: '100%' },
});
