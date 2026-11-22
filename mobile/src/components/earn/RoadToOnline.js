// mobile/src/components/earn/RoadToOnline.js
//
// The "Road to online" visuals: a progress ring, the dashboard card, and the road itself, a vertical road whose finished
// stretch is solid and whose road ahead is dashed, with the earner's own vehicle parked at the step they are on.
import React, { useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, Animated, Easing, StyleSheet } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import { BRAND } from '../../theme/theme';
import { STATE } from '../../utils/roadToOnline';
import { resolveVehicleIconKey, vehicleIconSource } from '../../utils/vehicleIcons';
import { useReduceMotion } from './EarnKit';

export const RED = '#E05555';

/** Words for a step: { title, detail, cta } from its state, with the reasons a reviewer gave. */
export function stepText(e, role, step) {
  const { id, state, info = {} } = step;
  const reason = info.note ? ` ${e('roadReasonPrefix', { reason: info.note })}` : '';
  switch (id) {
    case 'account': return { title: e('roadStepAccount'), detail: e('roadAccountDone') };
    case 'details': return {
      title: role === 'DRIVER' ? e('roadStepDetailsDriver') : e('roadStepDetailsCourier'),
      detail: state === STATE.DONE ? e('roadDetailsDone') : e('roadDetailsCurrent'),
      cta: state === STATE.CURRENT ? e('roadCtaDetails') : null,
    };
    case 'documents': return {
      title: e('roadStepDocuments'),
      detail: state === STATE.LOCKED ? e('roadDocumentsLocked') : state === STATE.DONE ? e('roadDocumentsDone', { total: info.total }) : e('roadDocumentsCurrent', { filled: info.filled, total: info.total }),
      cta: state === STATE.CURRENT ? (info.filled > 0 ? e('roadCtaContinue') : e('roadCtaDocuments')) : null,
    };
    case 'licence': return {
      title: e('roadStepLicence'),
      detail: state === STATE.DONE ? e('roadLicenceDone') : state === STATE.WAITING ? e('roadLicenceWaiting')
        : state === STATE.BLOCKED ? (info.reason === 'expired' ? e('roadLicenceExpired') : e('roadLicenceRejected') + reason) : e('roadLicenceLocked'),
      cta: state === STATE.BLOCKED ? e('roadCtaFix') : null,
    };
    case 'review': return {
      title: e('roadStepReview'),
      detail: state === STATE.DONE ? e('roadReviewDone') : state === STATE.WAITING ? e('roadReviewWaiting')
        : state === STATE.BLOCKED ? e('roadReviewRejected') + reason : e('roadReviewLocked'),
      cta: state === STATE.BLOCKED ? e('roadCtaFix') : null,
    };
    default: return {
      title: e('roadStepOnline'),
      detail: state === STATE.DONE ? e('roadOnlineDone') : state === STATE.CURRENT ? e('roadOnlineCurrent') : e('roadOnlineLocked'),
      cta: state === STATE.CURRENT ? e('roadCtaOnline') : null,
    };
  }
}

const stateColor = (state, accent) => (state === STATE.BLOCKED ? RED : state === STATE.WAITING ? BRAND.keke : state === STATE.LOCKED ? '#6B7F9E' : accent);
const stateIcon = (state) => (state === STATE.DONE ? 'checkmark' : state === STATE.WAITING ? 'hourglass-outline' : state === STATE.BLOCKED ? 'alert' : state === STATE.LOCKED ? 'lock-closed' : 'ellipse');

export function ProgressRing({ done, total, size = 52, stroke = 5, color, track, label, textColor }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const frac = total ? Math.min(1, done / total) : 0;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }} accessible accessibilityLabel={label}>
      <Svg width={size} height={size} style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={track} strokeWidth={stroke} fill="none" />
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={stroke} fill="none" strokeLinecap="round" strokeDasharray={`${c * frac} ${c}`} />
      </Svg>
      <Text style={{ color: textColor, fontSize: size * 0.3, fontWeight: '800' }}>{done}/{total}</Text>
    </View>
  );
}

const headKey = { blocked: 'roadHeadBlocked', action: 'roadHeadAction', waiting: 'roadHeadWaiting', done: 'roadHeadDone' };
export const headlineText = (e, road) => e(headKey[road.headline]);

/** Compact card for the top of the dashboard. `summary` is the pass draft's summary (optional). */
export function RoadCard({ role, road, accent, theme, e, onPress, planText }) {
  const focus = road.steps.find((s) => s.id === road.focusId);
  const next = focus ? stepText(e, role, focus).title : null;
  const blocked = road.headline === 'blocked';
  const border = blocked ? RED : accent + '66';
  return (
    <TouchableOpacity
      activeOpacity={0.88} onPress={onPress} accessibilityRole="button"
      accessibilityLabel={`${e('roadKicker')}. ${e('roadProgress', { done: road.doneCount, total: road.total })}. ${next ? e('roadNext', { step: next }) : headlineText(e, road)}`}
      style={[st.card, { backgroundColor: theme.backgroundAlt, borderColor: border }]}
    >
      <ProgressRing done={road.doneCount} total={road.total} color={blocked ? RED : accent} track={theme.border} textColor={theme.foreground}
        label={e('roadProgress', { done: road.doneCount, total: road.total })} />
      <View style={{ flex: 1 }}>
        <Text style={[st.kicker, { color: blocked ? RED : accent }]}>{e('roadKicker')}</Text>
        <Text style={[st.cardTitle, { color: theme.foreground }]} numberOfLines={1}>{next ? e('roadNext', { step: next }) : headlineText(e, road)}</Text>
        <Text style={[st.cardSub, { color: theme.muted }]} numberOfLines={1}>{planText || headlineText(e, road)}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={theme.hint} />
    </TouchableOpacity>
  );
}

function Parked({ vehicleType, size = 38 }) {
  const reduce = useReduceMotion();
  const bob = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduce) return undefined;
    const l = Animated.loop(Animated.sequence([
      Animated.timing(bob, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(bob, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]));
    l.start();
    return () => l.stop();
  }, [bob, reduce]);
  const y = bob.interpolate({ inputRange: [0, 1], outputRange: [-3, 3] });
  const key = resolveVehicleIconKey(vehicleType || 'CAR', { colour: 'blue' });
  // The artwork faces north; the road runs down the screen, so the vehicle is turned to face down it.
  return <Animated.Image source={vehicleIconSource(key)} resizeMode="contain" style={{ width: size, height: size, transform: [{ translateY: y }, { rotate: '180deg' }] }} />;
}

/** The road: one row per step. `onStep(step)` is called when the step's button is pressed. */
export function RoadList({ role, road, accent, theme, e, vehicleType, onStep }) {
  return (
    <View>
      {road.steps.map((s, i) => {
        const color = stateColor(s.state, accent);
        const txt = stepText(e, role, s);
        const here = s.id === road.focusId;
        const last = i === road.steps.length - 1;
        const nextDone = road.steps[i + 1]?.state === STATE.DONE;
        return (
          <View key={s.id} style={st.row}>
            <View style={st.rail}>
              <View style={[st.node, here ? null : { backgroundColor: s.state === STATE.DONE ? color : theme.backgroundAlt, borderColor: color }, here && st.nodeHere]}>
                {here
                  ? <Parked vehicleType={vehicleType} />
                  : <Ionicons name={stateIcon(s.state)} size={s.state === STATE.CURRENT ? 10 : 15} color={s.state === STATE.DONE ? '#FFFFFF' : color} />}
              </View>
              {!last && <View style={[st.spine, { borderColor: s.state === STATE.DONE && nextDone ? accent : s.state === STATE.DONE ? accent : theme.border, borderStyle: s.state === STATE.DONE ? 'solid' : 'dashed' }]} />}
            </View>
            <View style={[st.body, { borderColor: here ? color + '88' : theme.border, backgroundColor: here ? color + '10' : theme.backgroundAlt }]}>
              {here && <Text style={[st.here, { color }]}>{e('roadYouAreHere')}</Text>}
              <Text style={[st.stepTitle, { color: s.state === STATE.LOCKED ? theme.hint : theme.foreground }]}>{txt.title}</Text>
              <Text style={[st.stepDetail, { color: s.state === STATE.BLOCKED ? RED : theme.muted }]}>{txt.detail}</Text>
              {txt.cta ? (
                <TouchableOpacity activeOpacity={0.88} onPress={() => onStep(s)} accessibilityRole="button" accessibilityLabel={`${txt.cta}: ${txt.title}`}
                  style={[st.stepBtn, { backgroundColor: color }]}>
                  <Text style={st.stepBtnTxt}>{txt.cta}</Text>
                  <Ionicons name="arrow-forward" size={14} color="#0B1220" />
                </TouchableOpacity>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const st = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1.5, borderRadius: 18, padding: 12, marginBottom: 12 },
  kicker: { fontSize: 10, fontWeight: '900', letterSpacing: 2 },
  cardTitle: { fontSize: 15, fontWeight: '800', marginTop: 2 },
  cardSub: { fontSize: 12, marginTop: 2 },
  row: { flexDirection: 'row', gap: 12 },
  rail: { width: 40, alignItems: 'center' },
  node: { width: 30, height: 30, borderRadius: 15, borderWidth: 2, alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  nodeHere: { width: 40, height: 44, marginTop: 8 },
  spine: { flex: 1, borderLeftWidth: 3, marginTop: 2, marginBottom: -2, minHeight: 18 },
  body: { flex: 1, borderWidth: 1, borderRadius: 16, padding: 12, marginBottom: 12 },
  here: { fontSize: 9, fontWeight: '900', letterSpacing: 2, marginBottom: 4 },
  stepTitle: { fontSize: 15, fontWeight: '800' },
  stepDetail: { fontSize: 12.5, lineHeight: 18, marginTop: 3 },
  stepBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 42, borderRadius: 12, marginTop: 10 },
  stepBtnTxt: { color: '#0B1220', fontSize: 14, fontWeight: '800' },
});

/** One line about the pass the person activated at sign-up ("Planning about ₦120,000 – ₦210,000 a week"), or null. */
export function planText(e, draft, role, formatMoney) {
  const s = draft?.summary;
  if (!s || draft.path !== (role === 'DRIVER' ? 'DRIVER' : 'COURIER')) return null;
  const money = (n) => formatMoney(n, draft.currency);
  if (s.kind === 'week') return e('roadPassWeek', { range: s.low === s.high ? money(s.low) : `${money(s.low)} – ${money(s.high)}` });
  if (s.kind === 'run') return e('roadPassRun', { pay: money(s.pay), lo: s.runsLow, hi: s.runsHigh });
  return null;
}
