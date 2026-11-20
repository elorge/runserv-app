// mobile/src/screens/Customer/MyOrganisationScreen.js
//
// Staff side of Runserv for Business:
//   NONE / REJECTED → enter the organisation code + staff number + department to ask to join
//   PENDING         → waiting for the company rep to approve
//   ACTIVE          → this month's usage, weekend access requests, trip history (distance + cost)
import React, { useState, useCallback, useMemo } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, Alert,
  ActivityIndicator, RefreshControl, StatusBar, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useTheme } from '../../context/ThemeContext';
import { useCurrency } from '../../context/CurrencyContext';
import { corporateAPI } from '../../services/api';
import { useOrgAccount, clearOrgCache } from '../../hooks/useOrgAccount';

const BLUE = '#2563EB';
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const prettyDate = (s) => new Date(`${s}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

/** Upcoming Saturdays/Sundays the staff member may still ask for (per the company's weekend policy). */
const upcomingWeekendDays = (policy) => {
  const out = []; const d = new Date();
  for (let i = 0; i < 42 && out.length < 8; i++, d.setDate(d.getDate() + 1)) {
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) continue;
    if (policy === 'OPEN_SATURDAY' && wd === 6) continue;
    out.push({ date: iso(d), label: `${DAY[wd]} ${d.getDate()}/${d.getMonth() + 1}` });
  }
  return out;
};

const Card = ({ theme, children, style }) => (
  <View style={[st.card, { backgroundColor: theme.card, borderColor: theme.border }, style]}>{children}</View>
);
const Label = ({ theme, children }) => <Text style={[st.label, { color: theme.hint }]}>{children}</Text>;
const Field = ({ theme, ...p }) => (
  <TextInput placeholderTextColor={theme.hint} {...p}
    style={[st.input, { color: theme.foreground, borderColor: theme.border, backgroundColor: theme.background }, p.style]} />
);
const Btn = ({ title, onPress, busy, disabled, theme, outline, danger }) => (
  <TouchableOpacity onPress={onPress} disabled={busy || disabled} activeOpacity={0.85}
    style={[st.btn, outline
      ? { borderWidth: 1, borderColor: danger ? '#E05555' : theme.border, backgroundColor: 'transparent' }
      : { backgroundColor: danger ? '#E05555' : BLUE, opacity: disabled ? 0.45 : 1 }]}>
    {busy ? <ActivityIndicator color={outline ? theme.foreground : '#fff'} /> :
      <Text style={[st.btnTxt, { color: outline ? (danger ? '#E05555' : theme.foreground) : '#fff' }]}>{title}</Text>}
  </TouchableOpacity>
);

export default function MyOrganisationScreen({ navigation }) {
  const { theme, mode } = useTheme();
  const { formatMoney } = useCurrency();
  const insets = useSafeAreaInsets();
  const { org, loading, refresh } = useOrgAccount();

  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState(''); const [found, setFound] = useState(null);
  const [staffNumber, setStaffNumber] = useState('');
  const [trips, setTrips] = useState(null);
  const [wkDate, setWkDate] = useState(null); const [wkReason, setWkReason] = useState('');

  const reload = useCallback(async () => {
    clearOrgCache();
    const d = await refresh();
    if (d?.status === 'ACTIVE') {
      try { const r = await corporateAPI.getMyTrips(); setTrips(r?.data ?? r); } catch { setTrips(null); }
    }
  }, [refresh]);
  useFocusEffect(useCallback(() => { reload(); }, [reload]));
  const onRefresh = async () => { setRefreshing(true); await reload(); setRefreshing(false); };

  const lookup = async () => {
    if (!code.trim()) return;
    setBusy(true);
    try { const r = await corporateAPI.lookup(code.trim()); setFound((r?.data ?? r).organisation); }
    catch (e) { setFound(null); Alert.alert('Organisation not found', e?.message ?? 'Check the code with your company.'); }
    finally { setBusy(false); }
  };
  const submit = async () => {
    setBusy(true);
    try {
      await corporateAPI.requestToJoin({ orgCode: found?.orgCode ?? code.trim(), staffNumber: staffNumber.trim() });
      setFound(null); setCode(''); await reload();
    } catch (e) { Alert.alert('Could not send request', e?.message ?? 'Please try again.'); }
    finally { setBusy(false); }
  };
  const cancelReq = () => Alert.alert('Cancel request?', 'You can send a new one any time.', [
    { text: 'Keep it', style: 'cancel' },
    { text: 'Cancel request', style: 'destructive', onPress: async () => { try { await corporateAPI.cancelJoinRequest(); await reload(); } catch (e) { Alert.alert('Error', e?.message); } } },
  ]);
  const leave = () => Alert.alert('Leave organisation?', 'You will no longer be able to ride on the company account.', [
    { text: 'Stay', style: 'cancel' },
    { text: 'Leave', style: 'destructive', onPress: async () => { try { await corporateAPI.leave(); await reload(); } catch (e) { Alert.alert('Cannot leave', e?.message); } } },
  ]);
  const sendWeekend = async () => {
    setBusy(true);
    try { await corporateAPI.requestWeekend({ date: wkDate, reason: wkReason.trim() }); setWkDate(null); setWkReason(''); await reload();
      Alert.alert('Request sent', 'Your company admin will approve or decline it. You’ll get a notification.'); }
    catch (e) { Alert.alert('Could not send request', e?.message ?? 'Please try again.'); }
    finally { setBusy(false); }
  };
  const cancelWeekend = async (id) => { try { await corporateAPI.cancelWeekend(id); await reload(); } catch (e) { Alert.alert('Error', e?.message); } };

  const weekendDays = useMemo(() => upcomingWeekendDays(org?.weekendPolicy), [org?.weekendPolicy]);
  const takenDates = new Set((org?.weekendRequests ?? []).map((r) => r.date));

  const Header = (
    <View style={[st.header, { paddingTop: insets.top + 8 }]}>
      <TouchableOpacity onPress={() => navigation.goBack()} style={st.back} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
        <Ionicons name="chevron-back" size={24} color={theme.foreground} />
      </TouchableOpacity>
      <Text style={[st.title, { color: theme.foreground }]}>My organisation</Text>
      <View style={{ width: 24 }} />
    </View>
  );

  if (loading && !org) return (
    <View style={[st.root, { backgroundColor: theme.background }]}>{Header}<ActivityIndicator style={{ marginTop: 60 }} color={BLUE} /></View>);

  const status = org?.status ?? 'NONE';

  return (
    <View style={[st.root, { backgroundColor: theme.background }]}>
      <StatusBar barStyle={mode === 'dark' ? 'light-content' : 'dark-content'} />
      {Header}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }} keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={BLUE} />}>

          {/* ───── No organisation / declined ───── */}
          {(status === 'NONE' || status === 'REJECTED' || status === 'DELISTED') && (
            <>
              <Card theme={theme} style={{ alignItems: 'center' }}>
                <View style={[st.badge, { backgroundColor: BLUE + '18' }]}><Ionicons name="business" size={26} color={BLUE} /></View>
                <Text style={[st.h1, { color: theme.foreground }]}>Ride on your company</Text>
                <Text style={[st.p, { color: theme.hint, textAlign: 'center' }]}>
                  Ask your company to list you on Runserv with your staff ID. Once your HR approves, you can book rides and deliveries and your company pays — no cash, no expense claims. You stay a normal Runserv customer.
                </Text>
              </Card>

              {status === 'DELISTED' && (
                <Card theme={theme} style={{ borderColor: '#F59E0B88', backgroundColor: '#F59E0B14' }}>
                  <Text style={{ color: '#92400E', fontWeight: '700' }}>You’re no longer listed under {org?.organisation?.name}.</Text>
                  <Text style={[st.p, { color: '#92400E', marginTop: 4 }]}>Company rides are switched off for you. Your Runserv account works as normal — pay for rides yourself, or join another organisation below.</Text>
                </Card>)}

              {status === 'REJECTED' && (
                <Card theme={theme} style={{ borderColor: '#E0555566' }}>
                  <Text style={{ color: '#E05555', fontWeight: '700' }}>
                    {org?.reviewNote === 'Left the organisation' || org?.reviewNote === 'Cancelled by the staff member'
                      ? `You are no longer listed under ${org?.organisation?.name}.`
                      : `${org?.organisation?.name} declined your last request.`}
                  </Text>
                  {!!org?.reviewNote && !['Left the organisation', 'Cancelled by the staff member'].includes(org.reviewNote) &&
                    <Text style={[st.p, { color: theme.hint, marginTop: 4 }]}>“{org.reviewNote}”</Text>}
                  <Text style={[st.p, { color: theme.hint, marginTop: 6 }]}>Check your details with your company admin and send a new request below.</Text>
                </Card>)}

              <Card theme={theme}>
                <Label theme={theme}>ORGANISATION CODE</Label>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Field theme={theme} style={{ flex: 1 }} value={code} onChangeText={(v) => { setCode(v.toUpperCase()); setFound(null); }}
                    placeholder="RS-XXXXXX" autoCapitalize="characters" autoCorrect={false} maxLength={12} />
                  <TouchableOpacity onPress={lookup} disabled={busy || !code.trim()} style={[st.find, { backgroundColor: BLUE, opacity: code.trim() ? 1 : 0.45 }]}>
                    {busy && !found ? <ActivityIndicator color="#fff" size="small" /> : <Text style={{ color: '#fff', fontWeight: '700' }}>Find</Text>}
                  </TouchableOpacity>
                </View>
                <Text style={[st.p, { color: theme.hint, marginTop: 6 }]}>Ask your company admin for the code.</Text>

                {found && (
                  <View style={[st.found, { borderColor: '#16A34A66', backgroundColor: '#16A34A12' }]}>
                    <Ionicons name="checkmark-circle" size={20} color="#16A34A" />
                    <Text style={{ color: theme.foreground, fontWeight: '700', flex: 1 }}>{found.name}</Text>
                  </View>)}

                {found && (
                  <View style={{ marginTop: 14 }}>
                    <Label theme={theme}>YOUR STAFF ID</Label>
                    <Field theme={theme} value={staffNumber} onChangeText={setStaffNumber} placeholder="e.g. EMP-0042" autoCapitalize="characters" maxLength={40} />
                    <View style={{ height: 14 }} />
                    <Btn theme={theme} title="Send request" busy={busy} disabled={!staffNumber.trim()} onPress={submit} />
                    <Text style={[st.p, { color: theme.hint, marginTop: 8 }]}>HR checks your staff ID and name against the company’s staff records, then assigns your department and supervisor.</Text>
                  </View>)}
              </Card>
            </>
          )}

          {/* ───── Waiting for approval ───── */}
          {status === 'PENDING' && (
            <>
              <Card theme={theme} style={{ alignItems: 'center' }}>
                <View style={[st.badge, { backgroundColor: '#F59E0B22' }]}><Ionicons name="hourglass-outline" size={26} color="#F59E0B" /></View>
                <Text style={[st.h1, { color: theme.foreground }]}>Waiting for approval</Text>
                <Text style={[st.p, { color: theme.hint, textAlign: 'center' }]}>
                  {org.organisation?.name} will review your request. We’ll notify you as soon as they respond.
                </Text>
              </Card>
              <Card theme={theme}>
                {[['Organisation', org.organisation?.name], ['Code', org.organisation?.orgCode], ['Staff ID', org.staffNumber]].map(([k, v]) => (
                  <View key={k} style={st.row}><Text style={{ color: theme.hint }}>{k}</Text><Text style={{ color: theme.foreground, fontWeight: '600' }}>{v}</Text></View>))}
              </Card>
              <Btn theme={theme} outline danger title="Cancel request" onPress={cancelReq} />
            </>
          )}

          {/* ───── Approved ───── */}
          {status === 'ACTIVE' && (
            <>
              <Card theme={theme} style={{ backgroundColor: BLUE, borderColor: BLUE }}>
                <Text style={{ color: '#ffffffAA', fontSize: 12, fontWeight: '700', letterSpacing: 0.8 }}>RIDING ON</Text>
                <Text style={{ color: '#fff', fontSize: 22, fontWeight: '800', marginTop: 2 }}>{org.organisation?.name}</Text>
                <Text style={{ color: '#ffffffCC', marginTop: 2 }}>Staff ID {org.staffNumber}{org.jobTitle ? ` · ${org.jobTitle}` : ''}</Text>
                <Text style={{ color: '#ffffffCC', marginTop: 2 }}>{org.department ?? '—'}{org.costCenter ? ` · cost centre ${org.costCenter}` : ''}</Text>
                {!!org.supervisor && <Text style={{ color: '#ffffffCC', marginTop: 2 }}>Reports to {org.supervisor}</Text>}
                <View style={st.codePill}><Text style={{ color: '#fff', fontWeight: '700', letterSpacing: 1 }}>{org.organisation?.orgCode}</Text></View>
              </Card>

              {!org.canBookNow && (
                <Card theme={theme} style={{ borderColor: '#F59E0B88', backgroundColor: '#F59E0B14' }}>
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <Ionicons name="information-circle" size={18} color="#B45309" />
                    <Text style={{ flex: 1, color: '#92400E', lineHeight: 19 }}>{org.blockedReason}</Text>
                  </View>
                </Card>)}

              {org.hasPortal && (
                <Card theme={theme} style={{ borderColor: BLUE + '55', backgroundColor: BLUE + '10' }}>
                  <Text style={{ color: theme.foreground, fontWeight: '700' }}>You have {org.role.replace('_', ' ').toLowerCase()} access</Text>
                  <Text style={[st.p, { color: theme.hint, marginTop: 2 }]}>Sign in to your organisation’s web dashboard with this email to manage staff, approvals and costs.</Text>
                </Card>)}

              {(org.approvals ?? []).length > 0 && (
                <Card theme={theme}>
                  <Label theme={theme}>TRIPS WAITING FOR YOUR MANAGER</Label>
                  {org.approvals.map((a) => (
                    <View key={a.id} style={st.row}>
                      <View style={{ flex: 1 }}><Text style={{ color: theme.foreground, fontWeight: '600' }} numberOfLines={1}>{a.dropoff}</Text><Text style={{ color: theme.hint, fontSize: 12 }}>{formatMoney(a.fare)}</Text></View>
                      <Text style={{ color: a.status === 'APPROVED' ? '#16A34A' : '#B45309', fontWeight: '700' }}>{a.status === 'APPROVED' ? 'Approved — book it now' : 'Waiting'}</Text>
                    </View>))}
                </Card>)}

              <Card theme={theme}>
                <Label theme={theme}>THIS MONTH</Label>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 }}>
                  {[['Spent', formatMoney(org.usage?.spend ?? 0)], ['Trips', String(org.usage?.trips ?? 0)], ['Distance', `${org.usage?.distanceKm ?? 0} km`]].map(([k, v]) => (
                    <View key={k}><Text style={{ color: theme.hint, fontSize: 12 }}>{k}</Text><Text style={{ color: theme.foreground, fontSize: 18, fontWeight: '800', marginTop: 2 }}>{v}</Text></View>))}
                </View>
                {org.monthlyLimit != null && (
                  <>
                    <View style={[st.track, { backgroundColor: theme.border }]}>
                      <View style={{ height: '100%', borderRadius: 3, backgroundColor: (org.usage.spend / org.monthlyLimit) > 0.9 ? '#E05555' : BLUE, width: `${Math.min(100, (org.usage.spend / org.monthlyLimit) * 100)}%` }} />
                    </View>
                    <Text style={{ color: theme.hint, fontSize: 12, marginTop: 6 }}>{formatMoney(org.remaining)} left of your {formatMoney(org.monthlyLimit)} limit</Text>
                  </>)}
              </Card>

              <Card theme={theme}>
                <Label theme={theme}>WHEN YOU CAN RIDE ON THE COMPANY</Label>
                <Text style={{ color: theme.foreground, lineHeight: 20 }}>
                  <Text style={{ fontWeight: '700' }}>Monday – Friday</Text> — always.{'\n'}
                  <Text style={{ fontWeight: '700' }}>Saturday / Sunday</Text> — {{
                    APPROVAL_REQUIRED: 'with your company’s approval for that day.',
                    OPEN_SATURDAY: 'Saturdays are open; Sundays need approval.',
                    OPEN_WEEKEND: 'open, same as weekdays.',
                    CLOSED: 'not available on the company account.',
                  }[org.weekendPolicy]}
                </Text>

                {['APPROVAL_REQUIRED', 'OPEN_SATURDAY'].includes(org.weekendPolicy) && (
                  <View style={{ marginTop: 14 }}>
                    <Label theme={theme}>REQUEST A WEEKEND DAY</Label>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }}>
                      {weekendDays.map((d) => {
                        const on = wkDate === d.date; const taken = takenDates.has(d.date);
                        return (
                          <TouchableOpacity key={d.date} disabled={taken} onPress={() => setWkDate(on ? null : d.date)}
                            style={[st.chip, { borderColor: on ? BLUE : theme.border, backgroundColor: on ? BLUE + '1F' : 'transparent', opacity: taken ? 0.4 : 1 }]}>
                            <Text style={{ color: on ? BLUE : theme.foreground, fontWeight: on ? '700' : '500' }}>{d.label}</Text>
                          </TouchableOpacity>);
                      })}
                    </ScrollView>
                    {wkDate && (
                      <>
                        <Field theme={theme} value={wkReason} onChangeText={setWkReason} placeholder="Why do you need to ride? (e.g. Client event, Lekki)" maxLength={300} />
                        <View style={{ height: 10 }} />
                        <Btn theme={theme} title={`Send request for ${prettyDate(wkDate)}`} busy={busy} disabled={wkReason.trim().length < 5} onPress={sendWeekend} />
                      </>)}
                  </View>)}

                {(org.weekendRequests ?? []).length > 0 && (
                  <View style={{ marginTop: 14 }}>
                    <Label theme={theme}>YOUR WEEKEND REQUESTS</Label>
                    {org.weekendRequests.map((r) => (
                      <View key={r.id} style={st.row}>
                        <View style={{ flex: 1 }}><Text style={{ color: theme.foreground, fontWeight: '600' }}>{prettyDate(r.date)}</Text>
                          <Text style={{ color: theme.hint, fontSize: 12 }} numberOfLines={1}>{r.reason}</Text></View>
                        <Text style={{ color: r.status === 'APPROVED' ? '#16A34A' : '#B45309', fontWeight: '700', marginRight: 10 }}>{r.status === 'APPROVED' ? 'Approved' : 'Waiting'}</Text>
                        <TouchableOpacity onPress={() => cancelWeekend(r.id)}><Ionicons name="close-circle-outline" size={20} color={theme.hint} /></TouchableOpacity>
                      </View>))}
                  </View>)}
              </Card>

              <Card theme={theme}>
                <Label theme={theme}>YOUR COMPANY TRIPS THIS MONTH</Label>
                {!trips ? <ActivityIndicator color={BLUE} /> : trips.trips.length === 0 ? (
                  <Text style={{ color: theme.hint }}>No completed company trips yet. Choose “{org.organisation?.name}” as the payer when you book.</Text>
                ) : trips.trips.map((t) => (
                  <View key={t.id} style={[st.trip, { borderColor: theme.border }]}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: theme.foreground, fontWeight: '600' }} numberOfLines={1}>{t.from} → {t.to}</Text>
                      <Text style={{ color: theme.hint, fontSize: 12, marginTop: 2 }}>
                        {new Date(t.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · {t.distanceKm != null ? `${t.distanceKm.toFixed(1)} km` : '—'}{t.purpose ? ` · ${t.purpose}` : ''}
                      </Text>
                    </View>
                    <Text style={{ color: theme.foreground, fontWeight: '800' }}>{formatMoney(t.fare)}</Text>
                  </View>))}
              </Card>

              {org.role === 'STAFF' && <Btn theme={theme} outline danger title="Leave organisation" onPress={leave} />}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 8 },
  back: { width: 24 }, title: { fontSize: 18, fontWeight: '800' },
  card: { borderWidth: 1, borderRadius: 16, padding: 16, marginBottom: 12 },
  badge: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  h1: { fontSize: 20, fontWeight: '800', marginBottom: 6 }, p: { fontSize: 13, lineHeight: 19 },
  label: { fontSize: 10, fontWeight: '700', letterSpacing: 0.8, marginBottom: 8 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 },
  btn: { borderRadius: 12, paddingVertical: 14, alignItems: 'center', justifyContent: 'center' }, btnTxt: { fontSize: 15, fontWeight: '700' },
  find: { borderRadius: 12, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  found: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 12 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 7 },
  codePill: { alignSelf: 'flex-start', backgroundColor: '#ffffff26', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, marginTop: 10 },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  chip: { borderWidth: 1, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8, marginRight: 8 },
  trip: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
});
