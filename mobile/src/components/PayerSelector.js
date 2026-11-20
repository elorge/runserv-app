// mobile/src/components/PayerSelector.js
//
// "Who pays for this trip?" — shown on the ride and delivery booking screens ONLY for staff who
// have been approved by their organisation.
//   • Company  → billed to the organisation's monthly invoice (needs a short reason for the trip)
//   • Myself   → the normal payment methods below
//
// value:    { payer: 'SELF' | 'ORGANIZATION', purpose: string, purposeCategory: string|null }
// onChange: (nextValue) => void
import React, { useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, TextInput, StyleSheet, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useCurrency } from '../context/CurrencyContext';
import { useOrgAccount } from '../hooks/useOrgAccount';

export const DEFAULT_PAYER = { payer: 'SELF', purpose: '', purposeCategory: null, approvalId: null };

const CATEGORY_LABEL = {
  CLIENT_VISIT: 'Client visit', MARKETING_CALL: 'Marketing call', SITE_VISIT: 'Site visit',
  OFFICE_ERRAND: 'Office errand', AIRPORT: 'Airport', MEETING: 'Meeting', OTHER: 'Other',
};

/** Payload fields for rideAPI / deliveryAPI. Nothing extra is sent for personal payments. */
export const payerPayload = (v) =>
  v?.payer === 'ORGANIZATION'
    ? { payer: 'ORGANIZATION', purpose: (v.purpose || '').trim(), purposeCategory: v.purposeCategory || undefined, approvalId: v.approvalId || undefined }
    : {};

export const PayerSelector = ({ value, onChange, theme, accentColor, serviceType = 'RIDE' }) => {
  const navigation = useNavigation();
  const { formatMoney } = useCurrency();
  const { org, loading } = useOrgAccount();
  const defaulted = useRef(false);

  const member  = org?.status === 'ACTIVE';
  const blocked = member && !org.canBookNow;
  const noDelivery = member && serviceType === 'DELIVERY' && org.allowDeliveries === false;
  const usable  = member && !blocked && !noDelivery;

  // First time we learn the user can book on the company, preselect it.
  useEffect(() => {
    if (defaulted.current || !org) return;
    defaulted.current = true;
    if (usable) onChange({ ...DEFAULT_PAYER, payer: 'ORGANIZATION' });
  }, [org, usable]); // eslint-disable-line

  // If the company option is not usable, never leave it selected.
  useEffect(() => {
    if (org && !usable && value.payer === 'ORGANIZATION') onChange(DEFAULT_PAYER);
  }, [org, usable]); // eslint-disable-line

  // A manager-approved trip is waiting: attach the pass so booking goes straight through.
  const pass = org?.approvals?.find((a) => a.status === 'APPROVED');
  useEffect(() => {
    if (value.payer === 'ORGANIZATION' && pass && value.approvalId !== pass.id) onChange({ ...value, approvalId: pass.id });
  }, [pass?.id, value.payer]); // eslint-disable-line

  if (loading || !org || org.status !== 'ACTIVE') return null;

  const onOrg = value.payer === 'ORGANIZATION';
  const set = (patch) => onChange({ ...value, ...patch });
  const reason = blocked ? org.blockedReason : noDelivery ? 'Your organisation has not enabled company-paid deliveries.' : null;
  const needsWeekend = blocked && org.blockedCode === 'ORG_WEEKEND_APPROVAL_REQUIRED';

  const Option = ({ id, icon, title, sub, disabled }) => {
    const selected = value.payer === id;
    return (
      <TouchableOpacity
        style={[st.option, { borderColor: selected ? accentColor : theme.border, backgroundColor: selected ? accentColor + '14' : 'transparent', opacity: disabled ? 0.5 : 1 }]}
        onPress={() => !disabled && set({ payer: id })} activeOpacity={0.8} accessibilityRole="radio" accessibilityState={{ selected, disabled }}>
        <Ionicons name={icon} size={18} color={selected ? accentColor : theme.hint} />
        <View style={{ flex: 1 }}>
          <Text style={[st.optTitle, { color: theme.foreground }]} numberOfLines={1}>{title}</Text>
          <Text style={[st.optSub, { color: theme.hint }]} numberOfLines={1}>{sub}</Text>
        </View>
        <Ionicons name={selected ? 'radio-button-on' : 'radio-button-off'} size={18} color={selected ? accentColor : theme.border} />
      </TouchableOpacity>
    );
  };

  return (
    <View style={[st.wrap, { backgroundColor: theme.backgroundAlt, borderColor: theme.border }]}>
      <Text style={[st.label, { color: theme.hint }]}>WHO PAYS?</Text>
      <Option id="ORGANIZATION" icon="business-outline" title={org.organisation?.name ?? 'My company'}
        sub={`Billed to your company · ${org.organisation?.orgCode}`} disabled={!usable} />
      <Option id="SELF" icon="person-outline" title="Myself" sub="Pay with cash, wallet or card" />

      {reason && (
        <View style={st.notice}>
          <Ionicons name="information-circle-outline" size={15} color="#B45309" />
          <Text style={st.noticeTxt}>{reason}</Text>
        </View>
      )}
      {needsWeekend && (
        <TouchableOpacity onPress={() => navigation.navigate('MyOrganisation')} style={st.linkBtn}>
          <Text style={[st.linkTxt, { color: accentColor }]}>Request weekend access →</Text>
        </TouchableOpacity>
      )}

      {onOrg && usable && !!pass && (
        <View style={[st.notice, { backgroundColor: '#DCFCE7' }]}>
          <Ionicons name="checkmark-circle" size={15} color="#166534" />
          <Text style={[st.noticeTxt, { color: '#166534' }]}>Your manager approved a trip to {pass.dropoff}. Book it now.</Text>
        </View>)}
      {onOrg && usable && !pass && org.approvalThreshold != null && (
        <Text style={[st.hint, { color: theme.hint, marginTop: 4 }]}>Trips over {formatMoney(org.approvalThreshold)} need your manager’s approval first.</Text>)}

      {onOrg && usable && (
        <View style={{ marginTop: 10 }}>
          <Text style={[st.label, { color: theme.hint }]}>WHY ARE YOU TRAVELLING?{org.requireTripPurpose ? '' : ' (OPTIONAL)'}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
            {org.purposeOptions?.map((c) => {
              const on = value.purposeCategory === c;
              return (
                <TouchableOpacity key={c} onPress={() => set({ purposeCategory: on ? null : c })}
                  style={[st.chip, { borderColor: on ? accentColor : theme.border, backgroundColor: on ? accentColor + '1F' : 'transparent' }]}>
                  <Text style={{ fontSize: 12, color: on ? accentColor : theme.muted, fontWeight: on ? '700' : '500' }}>{CATEGORY_LABEL[c] ?? c}</Text>
                </TouchableOpacity>);
            })}
          </ScrollView>
          <TextInput
            value={value.purpose} onChangeText={(v) => set({ purpose: v })} maxLength={300}
            placeholder={serviceType === 'DELIVERY' ? 'e.g. Contract documents to Zenith Bank, VI' : 'e.g. Client visit — Zenith Bank, VI'}
            placeholderTextColor={theme.hint}
            style={[st.input, { color: theme.foreground, borderColor: theme.border, backgroundColor: theme.background }]} />
          <Text style={[st.hint, { color: theme.hint }]}>
            Your company sees this with the trip's distance and cost.
            {org.remaining != null ? `  ${formatMoney(org.remaining)} left of your monthly limit.` : ''}
          </Text>
        </View>
      )}
    </View>
  );
};

const st = StyleSheet.create({
  wrap:   { borderWidth: 1, borderRadius: 14, padding: 12, marginTop: 10 },
  label:  { fontSize: 10, fontWeight: '700', letterSpacing: 0.8, marginBottom: 8 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1.5, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 8 },
  optTitle: { fontSize: 14, fontWeight: '700' },
  optSub:   { fontSize: 11, marginTop: 1 },
  notice: { flexDirection: 'row', gap: 6, alignItems: 'flex-start', backgroundColor: '#FEF3C7', borderRadius: 10, padding: 10, marginTop: 2 },
  noticeTxt: { flex: 1, fontSize: 12, color: '#92400E', lineHeight: 17 },
  linkBtn: { paddingVertical: 8 },
  linkTxt: { fontSize: 13, fontWeight: '700' },
  chip:   { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6, marginRight: 6 },
  input:  { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  hint:   { fontSize: 11, marginTop: 6, lineHeight: 15 },
});
