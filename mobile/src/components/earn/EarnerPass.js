// mobile/src/components/earn/EarnerPass.js
//
// The Driver Pass and the Courier Pass: the earner's version of the customer's boarding pass.
//   Driver Pass  – a duty-roster ticket: the days you work, the hours, your asking price stamped on it and the weekly RANGE.
//   Courier Pass – a waybill: pickup -> drop-off tape, the parcel, what a run pays and how many runs fit in a shift.
// Purely presentational: the screen computes every figure and string and hands them in.
import React from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { BRAND } from '../../theme/theme';

export const DRIVER_ACCENT = '#10B981';
export const COURIER_ACCENT = '#F59E0B';

// Pseudo-barcode: deterministic from the code, so the same pass always looks the same.
export const barsFor = (code) => {
  let seed = 7;
  for (let i = 0; i < code.length; i += 1) seed = (seed * 31 + code.charCodeAt(i)) % 9973;
  const out = [];
  for (let i = 0; i < 34; i += 1) { seed = (seed * 133 + 71) % 9973; out.push(1 + (seed % 4)); }
  return out;
};

function Perforation({ theme }) {
  return (
    <View style={st.perf}>
      <View style={[st.notch, { left: -12, backgroundColor: theme.background, borderColor: theme.border }]} />
      <View style={[st.perfLine, { borderColor: theme.border }]} />
      <View style={[st.notch, { right: -12, backgroundColor: theme.background, borderColor: theme.border }]} />
    </View>
  );
}

function Barcode({ code, theme }) {
  return (
    <View style={st.bars}>
      {barsFor(code).map((w, i) => (
        <View key={i} style={{ width: w, height: i % 5 === 0 ? 46 : 38, marginRight: 1.5, backgroundColor: theme.foreground, opacity: 0.85 }} />
      ))}
    </View>
  );
}

function Status({ activated, mode, e }) {
  const warn = mode === 'dark' ? BRAND.keke : '#8A6200';
  const ok = mode === 'dark' ? '#34D399' : '#047857';
  const c = activated ? ok : warn;
  return (
    <View style={[st.status, { backgroundColor: (activated ? DRIVER_ACCENT : BRAND.keke) + '22' }]}>
      <Ionicons name={activated ? 'checkmark-circle' : 'lock-closed'} size={12} color={c} />
      <Text style={[st.statusTxt, { color: c }]}>{activated ? e('passActive') : e('passNotActive')}</Text>
    </View>
  );
}

export default function EarnerPass({ path, passCode, theme, mode, e, activated = false, data }) {
  const isDriver = path === 'DRIVER';
  const accent = isDriver ? DRIVER_ACCENT : COURIER_ACCENT;
  const grad = isDriver ? [BRAND.navy, '#064E3B', '#10B981'] : [BRAND.navy, '#6B3F02', '#F59E0B'];

  return (
    <View
      accessible
      accessibilityLabel={data.a11y}
      style={[st.ticket, { backgroundColor: theme.backgroundAlt, borderColor: theme.border, shadowColor: accent }]}
    >
      <LinearGradient colors={grad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={st.head}>
        <View style={st.headL}>
          <Ionicons name={isDriver ? 'speedometer' : 'cube'} size={17} color={isDriver ? '#A7F3D0' : '#FDE68A'} />
          <Text style={st.brand}>{isDriver ? e('passBrandDriver') : e('passBrandCourier')}</Text>
        </View>
        <Text style={[st.code, { color: isDriver ? '#A7F3D0' : '#FDE68A' }]}>{passCode}</Text>
      </LinearGradient>

      {isDriver ? (
        <View style={st.body}>
          <View style={st.rowTop}>
            <View style={[st.vehicleBox, { backgroundColor: accent + '22' }]}>
              <Image source={data.vehicleIcon} style={st.vehicleImg} resizeMode="contain" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[st.small, { color: theme.hint }]}>{e('passVehicle')}</Text>
              <Text style={[st.big, { color: theme.foreground }]} numberOfLines={1}>{data.vehicleName}</Text>
              <Text style={[st.sub, { color: theme.muted }]} numberOfLines={1}>{data.schedule}</Text>
            </View>
            {/* the stamp: your asking price, as a rubber stamp on the pass */}
            <View style={[st.stamp, { borderColor: accent }]}>
              <Text style={[st.stampTop, { color: accent }]}>{e('passAsking')}</Text>
              <Text style={[st.stampBig, { color: accent }]}>{data.askLabel}</Text>
            </View>
          </View>
          <View style={st.mini}>
            {data.letters.map((l, i) => {
              const on = data.days.includes(i);
              return (
                <View key={i} style={st.miniCol}>
                  <View style={[st.miniBar, { backgroundColor: on ? accent : theme.pill, borderColor: on ? accent : theme.border, height: on ? 34 : 14 }]} />
                  <Text style={[st.miniLetter, { color: on ? accent : theme.hint }]}>{l}</Text>
                </View>
              );
            })}
          </View>
        </View>
      ) : (
        <View style={st.body}>
          <View style={st.tapeRow}>
            <View style={{ flex: 1 }}>
              <Text style={[st.small, { color: theme.hint }]}>{e('passPickup')}</Text>
              <Text style={[st.place, { color: theme.foreground }]} numberOfLines={1}>{e('passPickupPlace')}</Text>
            </View>
            <View style={st.tapeMid}>
              <View style={[st.dot, { borderColor: accent }]} />
              <View style={[st.dash, { borderColor: accent }]} />
              <Ionicons name="cube" size={16} color={accent} />
            </View>
            <View style={{ flex: 1, alignItems: 'flex-end' }}>
              <Text style={[st.small, { color: theme.hint }]}>{e('passDropoff')}</Text>
              <Text style={[st.place, { color: theme.foreground }]} numberOfLines={1}>{e('passDropoffPlace')}</Text>
            </View>
          </View>
          <View style={st.stats}>
            {[[e('passParcel'), data.parcelName], [e('passDistance'), data.kmLabel], [e('passShift'), data.shiftLabel]].map(([k, v]) => (
              <View key={k} style={{ flex: 1 }}>
                <Text style={[st.small, { color: theme.hint }]}>{k}</Text>
                <Text style={[st.stat, { color: theme.foreground }]} numberOfLines={1}>{v}</Text>
              </View>
            ))}
          </View>
          {data.askLabel ? (
            <View style={[st.tag, { borderColor: accent }]}>
              <Text style={[st.tagTxt, { color: mode === 'dark' ? accent : '#8A5A00' }]}>{e('passAsking')} {data.askLabel}</Text>
            </View>
          ) : null}
        </View>
      )}

      <Perforation theme={theme} />

      <View style={st.foot}>
        <View style={{ flex: 1 }}>
          <Text style={[st.small, { color: theme.hint }]}>{isDriver ? e('passEstWeek') : e('passRunPays')}</Text>
          <Text style={[st.money, { color: theme.foreground }]} numberOfLines={1} adjustsFontSizeToFit>{data.headline}</Text>
          <Text style={[st.fine, { color: theme.muted }]} numberOfLines={2}>{data.footnote}</Text>
          <Status activated={activated} mode={mode} e={e} />
        </View>
        <Barcode code={passCode} theme={theme} />
      </View>
      <View style={[st.edge, { backgroundColor: accent }]} />
    </View>
  );
}

const st = StyleSheet.create({
  ticket: { borderRadius: 22, borderWidth: 1, overflow: 'hidden', shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.2, shadowRadius: 22, elevation: 8 },
  head: { paddingHorizontal: 16, paddingVertical: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  headL: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  brand: { color: '#FFFFFF', fontSize: 11, fontWeight: '800', letterSpacing: 1.6, flexShrink: 1 },
  code: { fontSize: 15, fontWeight: '800', letterSpacing: 2 },
  body: { padding: 16 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  vehicleBox: { width: 56, height: 56, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  vehicleImg: { width: 46, height: 46 },
  small: { fontSize: 10, fontWeight: '700', letterSpacing: 1.8 },
  big: { fontSize: 18, fontWeight: '800', marginTop: 2 },
  sub: { fontSize: 12, marginTop: 2, fontWeight: '500' },
  stamp: { borderWidth: 2, borderStyle: 'dashed', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4, alignItems: 'center', transform: [{ rotate: '-7deg' }] },
  stampTop: { fontSize: 8, fontWeight: '900', letterSpacing: 1.6 },
  stampBig: { fontSize: 15, fontWeight: '900', letterSpacing: 0.5 },
  mini: { flexDirection: 'row', alignItems: 'flex-end', gap: 6, marginTop: 14 },
  miniCol: { flex: 1, alignItems: 'center' },
  miniBar: { width: '100%', borderRadius: 7, borderWidth: 1 },
  miniLetter: { fontSize: 11, fontWeight: '800', marginTop: 4 },
  tapeRow: { flexDirection: 'row', alignItems: 'center' },
  tapeMid: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  dot: { width: 8, height: 8, borderRadius: 4, borderWidth: 2 },
  dash: { flex: 1, height: 0, borderTopWidth: 1.5, borderStyle: 'dashed', marginHorizontal: 4 },
  place: { fontSize: 15, fontWeight: '800', marginTop: 3 },
  stats: { flexDirection: 'row', marginTop: 16 },
  stat: { fontSize: 15, fontWeight: '800', marginTop: 3 },
  tag: { alignSelf: 'flex-start', borderWidth: 1.5, borderStyle: 'dashed', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, marginTop: 12 },
  tagTxt: { fontSize: 10, fontWeight: '900', letterSpacing: 1.2 },
  perf: { height: 24, justifyContent: 'center' },
  perfLine: { marginHorizontal: 18, borderTopWidth: 1.5, borderStyle: 'dashed' },
  notch: { position: 'absolute', top: 0, width: 24, height: 24, borderRadius: 12, borderWidth: 1 },
  foot: { padding: 16, paddingTop: 8, flexDirection: 'row', alignItems: 'center', gap: 12 },
  money: { fontSize: 24, fontWeight: '800', marginTop: 2, letterSpacing: -0.5 },
  fine: { fontSize: 11, marginTop: 3, lineHeight: 15 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, marginTop: 8 },
  statusTxt: { fontSize: 11, fontWeight: '700' },
  bars: { flexDirection: 'row', alignItems: 'flex-end', maxWidth: 140, overflow: 'hidden' },
  edge: { height: 4 },
});
