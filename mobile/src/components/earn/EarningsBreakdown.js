// mobile/src/components/earn/EarningsBreakdown.js
//
// Shows HOW an earnings estimate is worked out: customer fare, Runserv commission, estimated payout, the assumptions
// behind the range, what is NOT deducted, and a plain "this is not a promise" line. Pure display: every number comes from
// earningsEstimate.payoutBreakdown(), which reconciles by construction.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { es } from './earnStyles';
import { payoutBreakdown } from '../../utils/earningsEstimate';

function Row({ label, value, theme, strong, accent, minus }) {
  return (
    <View style={st.row}>
      <Text style={[st.label, { color: strong ? theme.foreground : theme.muted, fontWeight: strong ? '800' : '500' }]}>{label}</Text>
      <Text style={[st.value, { color: strong ? accent : theme.foreground, fontWeight: strong ? '800' : '600' }]}>{minus ? '− ' : ''}{value}</Text>
    </View>
  );
}

export default function EarningsBreakdown({ kind, trip, runs, asking, theme, e, money, accent }) {
  const b = payoutBreakdown(kind, trip);
  const pct = Math.round(b.commissionRate * 1000) / 10;
  return (
    <View style={[es.card, { backgroundColor: theme.backgroundAlt, borderColor: theme.border }]} accessible accessibilityLabel={e('bdTitle')}>
      <Text style={[es.label, { color: theme.hint, marginBottom: 8 }]}>{e('bdTitle')}</Text>
      <Row theme={theme} label={e(kind === 'COURIER' ? 'bdFareCourier' : 'bdFareDriver')} value={money(b.fare)} />
      {b.bookingFee > 0 ? <Row theme={theme} label={e('bdBookingFee')} value={money(b.bookingFee)} minus /> : null}
      <Row theme={theme} label={e('bdCommission', { pct })} value={money(b.commission)} minus />
      <View style={[st.rule, { backgroundColor: theme.border }]} />
      <Row theme={theme} label={e('bdPayout')} value={money(b.payout)} strong accent={accent} />
      {runs ? (
        <Text style={[st.note, { color: theme.muted }]}>
          {e('bdAssume', { lo: runs.low, hi: runs.high, unit: e(kind === 'COURIER' ? 'bdUnitRuns' : 'bdUnitTrips') })}
        </Text>
      ) : null}
      <Text style={[st.note, { color: theme.muted }]}>{e('bdCosts')}</Text>
      {asking ? <Text style={[st.note, { color: theme.muted }]}>{e('bdAskNote')}</Text> : null}
      <Text style={[st.note, { color: theme.hint }]}>{e('bdNotPromise')}</Text>
      <Text style={[st.note, { color: theme.hint }]}>{e('bdPassNote')}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingVertical: 3, gap: 12 },
  label: { flex: 1, fontSize: 13 },
  value: { fontSize: 14 },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: 6 },
  note: { fontSize: 11.5, lineHeight: 16, marginTop: 8 },
});
