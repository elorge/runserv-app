// mobile/src/screens/Shared/LocationSharingScreen.js — live-location consent for drivers and couriers.
// The driver / courier must agree here BEFORE they can go online. The wording shown is versioned
// (LOCATION_CONSENT_VERSION): when it changes, everyone is asked again. "Stop sharing" withdraws consent, takes the person
// offline and erases their stored position (blocked while a trip is in progress; the server says so with a code).
//
// Opened from the dashboards when going online needs consent, and from the "Location sharing" row on the dashboard.
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator, Alert, StatusBar } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { driverAPI, partnerAPI } from '../../services/api';
import liveLocation from '../../services/liveLocation';
import socketService from '../../services/socket';
import { LOCATION_CONSENT_VERSION, isActiveTripError, isConsentVersionError } from '../../services/locationConsent';

const GREEN = '#5DAA72'; const AMBER = '#FFB800';

const POINTS = [
  { icon: 'navigate-outline',    key: 'pointWhat' },
  { icon: 'people-outline',      key: 'pointWho' },
  { icon: 'time-outline',        key: 'pointWhen' },
  { icon: 'eye-off-outline',     key: 'pointNot' },
  { icon: 'hand-left-outline',   key: 'pointStop' },
];

export default function LocationSharingScreen({ navigation }) {
  const { theme, mode } = useTheme();
  const { user } = useAuth();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const isCourier = user?.role === 'DELIVERY_PARTNER';
  const api = isCourier ? partnerAPI : driverAPI;

  const [state, setState] = useState('loading');     // loading | ready | error
  const [consent, setConsent] = useState(null);      // { granted, needsReconsent, grantedAt, ... }
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { const r = await api.getLocationConsent(); setConsent(r?.data?.data?.consent ?? r?.data?.consent ?? null); setState('ready'); }
    catch { setState((p) => (p === 'ready' ? 'ready' : 'error')); }
  }, [api]);
  useEffect(() => { load(); }, [load]);

  const allow = async () => {
    setBusy(true);
    try {
      await api.setLocationConsent(true, LOCATION_CONSENT_VERSION);
      await load();
      // Back to wherever they came from; they can now go online.
      if (navigation.canGoBack()) navigation.goBack();
    } catch (err) {
      const msg = isConsentVersionError(err) ? t('locationSharing.updateApp') : (err?.response?.data?.message ?? t('locationSharing.failed'));
      Alert.alert(t('common.error'), msg);
    } finally { setBusy(false); }
  };

  const stop = () => {
    Alert.alert(t('locationSharing.stopConfirmTitle'), t('locationSharing.stopConfirmBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('locationSharing.stop'), style: 'destructive', onPress: async () => {
        setBusy(true);
        try {
          await api.setLocationConsent(false);
          liveLocation.stop();                       // nothing is sent from this phone any more
          socketService.goOffline();
          await load();
        } catch (err) {
          Alert.alert(t('common.error'), isActiveTripError(err) ? t('locationSharing.stopBlockedTrip') : (err?.response?.data?.message ?? t('locationSharing.failed')));
        } finally { setBusy(false); }
      } },
    ]);
  };

  const granted = !!consent?.granted;

  return (
    <View style={[s.root, { backgroundColor: theme.background, paddingTop: insets.top }]}>
      <StatusBar barStyle={mode === 'dark' ? 'light-content' : 'dark-content'} />
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={[s.back, { backgroundColor: theme.pill, borderColor: theme.pillBorder }]} accessibilityLabel={t('common.back', { defaultValue: 'Back' })}>
          <Ionicons name="chevron-back" size={20} color={theme.foreground} />
        </TouchableOpacity>
        <Text style={[s.h1, { color: theme.foreground }]}>{t('locationSharing.title')}</Text>
        <View style={{ width: 40 }} />
      </View>

      {state === 'loading' && <View style={s.center}><ActivityIndicator color={theme.foreground} /></View>}
      {state === 'error' && (
        <View style={s.center}>
          <Ionicons name="cloud-offline-outline" size={36} color={theme.hint} />
          <Text style={[s.h2, { color: theme.foreground }]}>{t('locationSharing.loadError')}</Text>
          <TouchableOpacity onPress={() => { setState('loading'); load(); }} style={[s.btn, { backgroundColor: theme.accent }]}>
            <Text style={[s.btnTxt, { color: theme.accentFg }]}>{t('offers.retry')}</Text>
          </TouchableOpacity>
        </View>
      )}

      {state === 'ready' && (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 120, gap: 14 }}>
          <View style={[s.hero, { backgroundColor: (granted ? GREEN : AMBER) + '14', borderColor: (granted ? GREEN : AMBER) + '55' }]}>
            <Ionicons name={granted ? 'shield-checkmark' : 'shield-outline'} size={30} color={granted ? GREEN : AMBER} />
            <View style={{ flex: 1 }}>
              <Text style={[s.heroTitle, { color: theme.foreground }]}>{granted ? t('locationSharing.onTitle') : consent?.needsReconsent ? t('locationSharing.reconsentTitle') : t('locationSharing.offTitle')}</Text>
              <Text style={[s.heroSub, { color: theme.hint }]}>{granted ? t('locationSharing.onSub') : consent?.needsReconsent ? t('locationSharing.reconsentSub') : t('locationSharing.offSub')}</Text>
            </View>
          </View>

          <Text style={[s.section, { color: theme.hint }]}>{t('locationSharing.howItWorks')}</Text>
          {POINTS.map((p) => (
            <View key={p.key} style={[s.item, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Ionicons name={p.icon} size={22} color={theme.accent} />
              <Text style={[s.itemTxt, { color: theme.foreground }]}>{t(`locationSharing.${p.key}${isCourier ? 'Courier' : ''}`, { defaultValue: t(`locationSharing.${p.key}`) })}</Text>
            </View>
          ))}
          <Text style={[s.note, { color: theme.hint }]}>{t('locationSharing.version', { v: LOCATION_CONSENT_VERSION })}</Text>
        </ScrollView>
      )}

      {state === 'ready' && (
        <View style={[s.footer, { backgroundColor: theme.background, borderTopColor: theme.border, paddingBottom: insets.bottom + 12 }]}>
          {!granted ? (
            <TouchableOpacity disabled={busy} onPress={allow} style={[s.primary, { backgroundColor: theme.accent, opacity: busy ? 0.6 : 1 }]} accessibilityRole="button">
              {busy ? <ActivityIndicator color={theme.accentFg} /> : <Text style={[s.primaryTxt, { color: theme.accentFg }]}>{t('locationSharing.allow')}</Text>}
            </TouchableOpacity>
          ) : (
            <TouchableOpacity disabled={busy} onPress={stop} style={[s.secondary, { borderColor: '#E05555', opacity: busy ? 0.6 : 1 }]} accessibilityRole="button">
              {busy ? <ActivityIndicator color="#E05555" /> : <Text style={[s.primaryTxt, { color: '#E05555' }]}>{t('locationSharing.stop')}</Text>}
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10 },
  back: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth },
  h1: { fontSize: 18, fontWeight: '800' },
  h2: { fontSize: 16, fontWeight: '800', textAlign: 'center', marginTop: 8 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  hero: { flexDirection: 'row', gap: 12, alignItems: 'center', borderWidth: 1, borderRadius: 18, padding: 16 },
  heroTitle: { fontSize: 17, fontWeight: '900' },
  heroSub: { fontSize: 13, lineHeight: 18, marginTop: 2 },
  section: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  item: { flexDirection: 'row', gap: 12, borderWidth: 1, borderRadius: 16, padding: 14, alignItems: 'flex-start' },
  itemTxt: { flex: 1, fontSize: 14, lineHeight: 20 },
  note: { fontSize: 11, lineHeight: 16, textAlign: 'center' },
  btn: { marginTop: 12, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 999 },
  btnTxt: { fontSize: 14, fontWeight: '800' },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 16, borderTopWidth: StyleSheet.hairlineWidth },
  primary: { height: 52, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  secondary: { height: 52, borderRadius: 999, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5 },
  primaryTxt: { fontSize: 15, fontWeight: '800' },
});
