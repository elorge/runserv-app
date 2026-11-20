// mobile/src/screens/Shared/DispatchStatusScreen.js — "Why am I not receiving jobs?" for drivers and couriers.
// Everything shown comes from GET /drivers|partners/dispatch-status: the same decision the server applies when the
// person goes online or accepts work, so this screen can never disagree with what the server will actually do.
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, RefreshControl, ActivityIndicator, StatusBar } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { driverAPI, partnerAPI } from '../../services/api';
import { REASON_ICON, reasonKey, warningKey } from '../../utils/dispatchStatus';

const GREEN = '#5DAA72'; const AMBER = '#FFB800'; const RED = '#E05555';

export default function DispatchStatusScreen({ navigation }) {
  const { theme, mode } = useTheme();
  const { user } = useAuth();
  const { t, i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const api = user?.role === 'DELIVERY_PARTNER' ? partnerAPI : driverAPI;
  const [status, setStatus] = useState(null);
  const [state, setState] = useState('loading');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (pull = false) => {
    if (pull) setRefreshing(true);
    try { const r = await api.getDispatchStatus(); setStatus(r?.data ?? null); setState('ready'); }
    catch { setState((prev) => (prev === 'ready' ? 'ready' : 'error')); }
    finally { setRefreshing(false); }
  }, [api]);
  useEffect(() => { load(); }, [load]);

  const reasonText = (r) => t(reasonKey(r.code), { defaultValue: r.message, doc: t(`dispatchStatus.doc_${r.doc}`, { defaultValue: r.doc ?? '' }) });
  const warnText = (w) => t(warningKey(w.code), { defaultValue: w.message, doc: t(`dispatchStatus.doc_${w.doc}`, { defaultValue: w.doc ?? '' }), date: w.expiresAt ? new Date(w.expiresAt).toLocaleDateString(i18n.language, { day: 'numeric', month: 'short', year: 'numeric' }) : '' });
  const ready = status?.canTakeJobs;

  return (
    <View style={[s.root, { backgroundColor: theme.background, paddingTop: insets.top }]}>
      <StatusBar barStyle={mode === 'dark' ? 'light-content' : 'dark-content'} />
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={[s.back, { backgroundColor: theme.pill, borderColor: theme.pillBorder }]} accessibilityLabel={t('common.back', { defaultValue: 'Back' })}>
          <Ionicons name="chevron-back" size={20} color={theme.foreground} />
        </TouchableOpacity>
        <Text style={[s.h1, { color: theme.foreground }]}>{t('dispatchStatus.title')}</Text>
        <View style={{ width: 40 }} />
      </View>

      {state === 'loading' && <View style={s.center}><ActivityIndicator color={theme.foreground} /></View>}
      {state === 'error' && (
        <View style={s.center}>
          <Ionicons name="cloud-offline-outline" size={36} color={theme.hint} />
          <Text style={[s.h2, { color: theme.foreground }]}>{t('dispatchStatus.errorTitle')}</Text>
          <TouchableOpacity onPress={() => { setState('loading'); load(); }} style={[s.btn, { backgroundColor: theme.accent }]}><Text style={[s.btnTxt, { color: theme.accentFg }]}>{t('offers.retry')}</Text></TouchableOpacity>
        </View>
      )}
      {state === 'ready' && status && (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 90, gap: 14 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={theme.foreground} />}>
          <View style={[s.hero, { backgroundColor: (ready ? GREEN : RED) + '14', borderColor: (ready ? GREEN : RED) + '55' }]}>
            <Ionicons name={ready ? 'checkmark-circle' : 'alert-circle'} size={30} color={ready ? GREEN : RED} />
            <View style={{ flex: 1 }}>
              <Text style={[s.heroTitle, { color: theme.foreground }]}>{ready ? t('dispatchStatus.readyTitle') : t('dispatchStatus.blockedTitle')}</Text>
              <Text style={[s.heroSub, { color: theme.muted }]}>{ready ? t('dispatchStatus.readySub') : t('dispatchStatus.blockedSub')}</Text>
            </View>
          </View>

          {status.isFleetDriver && (
            <View style={[s.panel, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Text style={[s.label, { color: theme.hint }]}>{t('dispatchStatus.yourFleet')}</Text>
              <Text style={[s.value, { color: theme.foreground }]}>{status.fleet?.name ?? '—'}</Text>
              <Text style={[s.label, { color: theme.hint, marginTop: 10 }]}>{t('dispatchStatus.yourVehicle')}</Text>
              <Text style={[s.value, { color: theme.foreground }]}>{status.vehicle?.registration ?? '—'}</Text>
            </View>
          )}

          {status.reasons.length > 0 && (
            <View style={{ gap: 10 }}>
              <Text style={[s.section, { color: theme.hint }]}>{t('dispatchStatus.whatToFix')}</Text>
              {status.reasons.map((r, i) => (
                <View key={`${r.code}-${r.doc ?? i}`} style={[s.item, { backgroundColor: theme.card, borderColor: RED + '44' }]}>
                  <Ionicons name={REASON_ICON[r.code] ?? 'alert-circle-outline'} size={20} color={RED} style={{ marginTop: 1 }} />
                  <View style={{ flex: 1 }}>
                    <Text style={[s.itemTxt, { color: theme.foreground }]}>{reasonText(r)}</Text>
                    {!!r.fixedBy && <Text style={[s.fix, { color: theme.hint }]}>{t(`dispatchStatus.fixedBy_${r.fixedBy}`, { defaultValue: '' })}</Text>}
                  </View>
                </View>
              ))}
            </View>
          )}

          {status.warnings.length > 0 && (
            <View style={{ gap: 10 }}>
              <Text style={[s.section, { color: theme.hint }]}>{t('dispatchStatus.comingUp')}</Text>
              {status.warnings.map((w, i) => (
                <View key={`${w.code}-${w.doc ?? i}`} style={[s.item, { backgroundColor: theme.card, borderColor: AMBER + '55' }]}>
                  <Ionicons name="time-outline" size={20} color={AMBER} style={{ marginTop: 1 }} />
                  <Text style={[s.itemTxt, { color: theme.foreground, flex: 1 }]}>{warnText(w)}</Text>
                </View>
              ))}
            </View>
          )}

          <TouchableOpacity onPress={() => navigation.navigate('Support')} style={[s.helpBtn, { borderColor: theme.border }]} accessibilityRole="button">
            <Ionicons name="help-buoy-outline" size={18} color={theme.foreground} />
            <Text style={[s.helpTxt, { color: theme.foreground }]}>{t('dispatchStatus.contactSupport')}</Text>
          </TouchableOpacity>
          <Text style={[s.note, { color: theme.hint }]}>{t('dispatchStatus.note')}</Text>
        </ScrollView>
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
  panel: { borderWidth: 1, borderRadius: 18, padding: 14 },
  label: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  value: { fontSize: 16, fontWeight: '800', marginTop: 2 },
  section: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  item: { flexDirection: 'row', gap: 12, borderWidth: 1, borderRadius: 16, padding: 14 },
  itemTxt: { fontSize: 14, lineHeight: 20 },
  fix: { fontSize: 12, marginTop: 4 },
  helpBtn: { flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderRadius: 999, height: 48, marginTop: 4 },
  helpTxt: { fontSize: 14, fontWeight: '700' },
  note: { fontSize: 11, lineHeight: 16, textAlign: 'center' },
  btn: { marginTop: 12, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 999 },
  btnTxt: { fontSize: 14, fontWeight: '800' },
});
