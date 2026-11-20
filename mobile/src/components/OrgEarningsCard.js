// mobile/src/components/OrgEarningsCard.js
// Driver / delivery-partner dashboard card: rides done for organisations, grouped by organisation,
// with the credit that is on its way to the wallet (and from there to the bank).
// Renders nothing until the user has done at least one company trip.
import React, { useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useCurrency } from '../context/CurrencyContext';
import { corporateAPI } from '../services/api';

const BLUE = '#2563EB';
const STATUS = {
  NOT_BILLED:       { label: 'Awaiting invoice',       color: '#6B7280' },
  AWAITING_COMPANY: { label: 'Company to pay',         color: '#B45309' },
  PAYING:           { label: 'Paying out',             color: BLUE },
  PAID:             { label: 'In your wallet',         color: '#16A34A' },
};

export const OrgEarningsCard = ({ theme, accent = BLUE }) => {
  const { formatMoney } = useCurrency();
  const [sum, setSum] = useState(null);
  const [open, setOpen] = useState(null);       // companyId whose trips are expanded
  const [trips, setTrips] = useState({});       // companyId → trips[]
  const [loadingTrips, setLoadingTrips] = useState(false);

  useFocusEffect(useCallback(() => {
    let alive = true;
    corporateAPI.getOrgEarnings().then((r) => { if (alive) setSum(r?.data ?? r); }).catch(() => {});
    return () => { alive = false; };
  }, []));

  const toggle = async (companyId) => {
    if (open === companyId) { setOpen(null); return; }
    setOpen(companyId);
    if (trips[companyId]) return;
    setLoadingTrips(true);
    try { const r = await corporateAPI.getOrgEarningTrips({ companyId, limit: 8 }); setTrips((p) => ({ ...p, [companyId]: (r?.data ?? r).trips })); }
    catch { setTrips((p) => ({ ...p, [companyId]: [] })); }
    finally { setLoadingTrips(false); }
  };

  if (!sum || !sum.totals || sum.totals.trips === 0) return null;
  const { totals } = sum;
  const coming = totals.notYetBilled + totals.awaitingCompanyPayment;

  return (
    <View style={[st.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <View style={st.head}>
        <View style={[st.icon, { backgroundColor: BLUE + '18' }]}><Ionicons name="business" size={18} color={BLUE} /></View>
        <View style={{ flex: 1 }}>
          <Text style={[st.title, { color: theme.foreground }]}>Company rides</Text>
          <Text style={[st.sub, { color: theme.hint }]}>Paid monthly, after each company settles its invoice</Text>
        </View>
      </View>

      <View style={st.kpis}>
        <View style={[st.kpi, { backgroundColor: theme.backgroundAlt }]}>
          <Text style={[st.kpiLbl, { color: theme.hint }]}>COMING TO YOUR WALLET</Text>
          <Text style={[st.kpiVal, { color: '#B45309' }]}>{formatMoney(coming)}</Text>
        </View>
        <View style={[st.kpi, { backgroundColor: theme.backgroundAlt }]}>
          <Text style={[st.kpiLbl, { color: theme.hint }]}>ALREADY PAID</Text>
          <Text style={[st.kpiVal, { color: '#16A34A' }]}>{formatMoney(totals.paid)}</Text>
        </View>
      </View>

      {sum.byOrganisation.map((o) => (
        <View key={o.companyId} style={[st.org, { borderColor: theme.border }]}>
          <TouchableOpacity onPress={() => toggle(o.companyId)} activeOpacity={0.8} style={st.orgRow}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: theme.foreground, fontWeight: '700' }}>{o.name}</Text>
              <Text style={{ color: theme.hint, fontSize: 12, marginTop: 1 }}>{o.trips} trip{o.trips === 1 ? '' : 's'} · {Number(o.distanceKm).toFixed(1)} km</Text>
            </View>
            <View style={{ alignItems: 'flex-end', marginRight: 6 }}>
              {(o.notYetBilled + o.awaitingCompanyPayment) > 0 && <Text style={{ color: '#B45309', fontWeight: '700' }}>{formatMoney(o.notYetBilled + o.awaitingCompanyPayment)}</Text>}
              {o.paid > 0 && <Text style={{ color: '#16A34A', fontSize: 12 }}>{formatMoney(o.paid)} paid</Text>}
            </View>
            <Ionicons name={open === o.companyId ? 'chevron-up' : 'chevron-down'} size={16} color={theme.hint} />
          </TouchableOpacity>

          {open === o.companyId && (
            <View style={{ paddingBottom: 8 }}>
              {loadingTrips && !trips[o.companyId] ? <ActivityIndicator color={accent} /> :
                (trips[o.companyId] ?? []).map((t) => {
                  const s = STATUS[t.status] ?? STATUS.NOT_BILLED;
                  return (
                    <View key={t.id} style={st.trip}>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: theme.foreground, fontSize: 13 }} numberOfLines={1}>{t.from} → {t.to}</Text>
                        <Text style={{ color: theme.hint, fontSize: 11, marginTop: 1 }}>
                          {new Date(t.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · {t.distanceKm != null ? `${Number(t.distanceKm).toFixed(1)} km` : '—'} · <Text style={{ color: s.color, fontWeight: '700' }}>{s.label}</Text>
                        </Text>
                      </View>
                      <Text style={{ color: theme.foreground, fontWeight: '700' }}>{formatMoney(t.earnings)}</Text>
                    </View>);
                })}
            </View>)}
        </View>))}

      {sum.payouts.length > 0 && (
        <View style={{ marginTop: 10 }}>
          <Text style={[st.kpiLbl, { color: theme.hint, marginBottom: 6 }]}>MONTHLY PAYOUTS</Text>
          {sum.payouts.slice(0, 4).map((p) => (
            <View key={p.id} style={st.payout}>
              <Text style={{ color: theme.foreground, flex: 1 }} numberOfLines={1}>{p.organisation} · {p.period}</Text>
              <Text style={{ color: p.status === 'PAID' ? '#16A34A' : '#B45309', fontWeight: '700' }}>{formatMoney(p.amount)}</Text>
            </View>))}
        </View>)}
    </View>
  );
};

const st = StyleSheet.create({
  card:  { borderWidth: 1, borderRadius: 16, padding: 14, marginBottom: 14 },
  head:  { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  icon:  { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 15, fontWeight: '800' }, sub: { fontSize: 11.5, marginTop: 1 },
  kpis:  { flexDirection: 'row', gap: 10, marginBottom: 10 },
  kpi:   { flex: 1, borderRadius: 12, padding: 12 },
  kpiLbl:{ fontSize: 9.5, fontWeight: '700', letterSpacing: 0.7 }, kpiVal: { fontSize: 18, fontWeight: '800', marginTop: 4 },
  org:   { borderTopWidth: StyleSheet.hairlineWidth },
  orgRow:{ flexDirection: 'row', alignItems: 'center', paddingVertical: 11 },
  trip:  { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 7, paddingLeft: 6 },
  payout:{ flexDirection: 'row', alignItems: 'center', paddingVertical: 5 },
});
