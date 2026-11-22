// mobile/src/components/earn/EarnKit.js
//
// Small building blocks shared by the Driver "Earnings Simulator" and the Courier "Parcel Run":
//   DragSlider  – a drag-anywhere slider that also works with a screen reader (increment / decrement actions)
//   CountUp     – a number that rolls to its new value (instant when the phone asks for reduced motion)
//   useReduceMotion – respects the system "reduce motion" setting
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { View, Text, Animated, Easing, PanResponder, StyleSheet, AccessibilityInfo, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export function useReduceMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled?.().then((v) => { if (alive) setReduce(!!v); }).catch(() => {});
    const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', (v) => setReduce(!!v));
    return () => { alive = false; sub?.remove?.(); };
  }, []);
  return reduce;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * Drag anywhere on the strip (or tap) to set a value between min and max, in whole `step`s.
 * `format` turns the value into spoken text for screen readers.
 */
export function DragSlider({ value, min, max, step = 1, onChange, color, trackColor, thumbBorder, label, format, ticks, tickColor, height = 48 }) {
  const widthRef = useRef(1);
  const valueRef = useRef(value);
  const startRef = useRef(value);
  valueRef.current = value;
  const cb = useRef(onChange);
  cb.current = onChange;

  const snap = useCallback((v) => {
    const s = clamp(Math.round((v - min) / step) * step + min, min, max);
    return Math.round(s * 1000) / 1000;
  }, [min, max, step]);

  const emit = useCallback((v) => { const n = snap(v); if (n !== valueRef.current) cb.current?.(n); }, [snap]);

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => {
      // Tap to jump: the thumb goes where the finger lands, then follows the finger.
      const x = e.nativeEvent.locationX;
      if (Number.isFinite(x)) emit(min + (clamp(x, 0, widthRef.current) / widthRef.current) * (max - min));
      startRef.current = valueRef.current;
    },
    onPanResponderMove: (_, g) => emit(startRef.current + (g.dx / widthRef.current) * (max - min)),
  })).current;

  const pct = ((value - min) / (max - min)) * 100;

  return (
    <View
      style={{ height, justifyContent: 'center' }}
      {...pan.panHandlers}
      onLayout={(e) => { widthRef.current = Math.max(1, e.nativeEvent.layout.width); }}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min, max, now: value, text: format ? format(value) : String(value) }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'increment') emit(valueRef.current + step);
        if (e.nativeEvent.actionName === 'decrement') emit(valueRef.current - step);
      }}
    >
      <View style={[st.track, { backgroundColor: trackColor }]}>
        <View style={[st.fill, { width: `${pct}%`, backgroundColor: color }]} />
      </View>
      {Array.isArray(ticks) && ticks.map((tv) => (
        <View key={tv} pointerEvents="none" style={[st.tick, { left: `${((tv - min) / (max - min)) * 100}%`, backgroundColor: tickColor || trackColor }]} />
      ))}
      <View pointerEvents="none" style={[st.thumb, { left: `${pct}%`, borderColor: color, shadowColor: color, backgroundColor: thumbBorder || '#FFFFFF' }]} />
    </View>
  );
}

/** A number that rolls to its new value. `format(n)` returns the text; `style` is a Text style. */
export function CountUp({ value, format, style, duration = 520 }) {
  const reduce = useReduceMotion();
  const a = useRef(new Animated.Value(value)).current;
  const [shown, setShown] = useState(value);

  useEffect(() => {
    const id = a.addListener(({ value: v }) => setShown(v));
    return () => a.removeListener(id);
  }, [a]);

  useEffect(() => {
    if (reduce || duration <= 0) { a.setValue(value); return undefined; }
    const anim = Animated.timing(a, { toValue: value, duration, easing: Easing.out(Easing.cubic), useNativeDriver: false });
    anim.start();
    return () => anim.stop();
  }, [value, reduce, duration, a]);

  return <Text style={style} numberOfLines={1} adjustsFontSizeToFit>{format(shown)}</Text>;
}

/** The big role-coloured call-to-action button. `ink` is the text colour (dark on emerald / amber for contrast). */
export function Cta({ onPress, label, icon = 'arrow-forward', color, ink, disabled }) {
  return (
    <TouchableOpacity
      activeOpacity={0.88} onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label}
      style={[st.cta, { backgroundColor: color, shadowColor: color, opacity: disabled ? 0.5 : 1 }]}
    >
      <Text style={[st.ctaTxt, { color: ink }]}>{label}</Text>
      <Ionicons name={icon} size={18} color={ink} />
    </TouchableOpacity>
  );
}

/** "How we estimate": a tap-to-open box that lists the planning assumptions behind a figure. */
export function Disclosure({ title, lines, theme, color }) {
  const [open, setOpen] = useState(false);
  return (
    <View>
      <TouchableOpacity
        onPress={() => setOpen((o) => !o)} activeOpacity={0.8} accessibilityRole="button"
        accessibilityState={{ expanded: open }} accessibilityLabel={title} style={st.link}
      >
        <Ionicons name={open ? 'chevron-up-circle-outline' : 'information-circle-outline'} size={16} color={color} />
        <Text style={[st.linkTxt, { color }]}>{title}</Text>
      </TouchableOpacity>
      {open && (
        <View style={[st.how, { borderColor: theme.border, backgroundColor: theme.pill }]}>
          {lines.map((l, i) => <Text key={i} style={[st.howRow, { color: theme.muted }]}>{'\u2022  '}{l}</Text>)}
        </View>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  cta: { marginTop: 18, height: 54, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.35, shadowRadius: 18, elevation: 10 },
  ctaTxt: { fontSize: 16, fontWeight: '800', letterSpacing: 0.3 },
  link: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, alignSelf: 'flex-start', paddingVertical: 4 },
  linkTxt: { fontSize: 13, fontWeight: '700' },
  how: { borderWidth: 1, borderRadius: 14, padding: 12, marginTop: 6 },
  howRow: { fontSize: 12.5, lineHeight: 18, marginBottom: 4 },
  track: { height: 8, borderRadius: 4, overflow: 'hidden' },
  fill: { height: 8, borderRadius: 4 },
  tick: { position: 'absolute', width: 2, height: 14, borderRadius: 1, top: '50%', marginTop: -7, marginLeft: -1, opacity: 0.55 },
  thumb: {
    position: 'absolute', width: 28, height: 28, borderRadius: 14, borderWidth: 3, marginLeft: -14, top: '50%', marginTop: -14,
    shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.4, shadowRadius: 6, elevation: 5,
  },
});
