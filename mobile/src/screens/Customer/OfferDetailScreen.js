// mobile/src/screens/Customer/OfferDetailScreen.js — one bank offer: who, what, who qualifies, until when, the terms.
// "Continue to the bank" records the click on the server (opaque referral code only — no personal data is sent to the
// bank), then opens the returned link only if it is a plain https link, after telling the customer where they are going.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator, Alert, Linking, StatusBar } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../context/ThemeContext';
import { offersAPI } from '../../services/api';
import { isSafeOutboundUrl, hostOf } from '../../utils/offers';
import { BankMark, useExpiryText } from './OffersScreen';

export default function OfferDetailScreen({ navigation, route }) {
  const { theme, mode } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const expiryText = useExpiryText();
  const { offerId, offer: preview } = route.params ?? {};
  const [offer, setOffer] = useState(preview ?? null);
  const [state, setState] = useState(preview ? 'ready' : 'loading'); // loading | ready | gone | error
  const [busy, setBusy] = useState(false);
  const lock = useRef(false); // a double tap must not create two referrals

  const load = useCallback(async () => {
    if (!offerId) { setState('gone'); return; }
    try { const r = await offersAPI.get(offerId); setOffer(r?.data?.offer ?? null); setState(r?.data?.offer ? 'ready' : 'gone'); }
    catch (e) { setState(e?.response?.status === 404 || e?.statusCode === 404 ? 'gone' : (preview ? 'ready' : 'error')); }
  }, [offerId, preview]);
  useEffect(() => { load(); }, [load]); // also refreshes the terms, which are always read from the server

  const goToBank = async () => {
    if (lock.current || !offer) return;
    lock.current = true; setBusy(true);
    try {
      const res = await offersAPI.click(offer.id);
      const { url, bankName } = res?.data ?? {};
      if (!isSafeOutboundUrl(url)) { Alert.alert(t('offers.linkProblemTitle'), t('offers.linkProblemBody')); return; }
      Alert.alert(
        t('offers.leavingTitle', { bank: bankName ?? offer.bank.name }),
        t('offers.leavingBody', { host: hostOf(url) }),
        [
          { text: t('offers.cancel'), style: 'cancel' },
          { text: t('offers.continue'), onPress: () => Linking.openURL(url).catch(() => Alert.alert(t('offers.linkProblemTitle'), t('offers.linkProblemBody'))) },
        ],
      );
    } catch (e) {
      const gone = e?.response?.status === 404 || e?.statusCode === 404;
      Alert.alert(t('offers.errorTitle'), gone ? t('offers.noLongerAvailable') : (e?.message && typeof e.message === 'string' && e.message.length < 140 ? e.message : t('offers.errorSub')));
      if (gone) setState('gone');
    } finally { lock.current = false; setBusy(false); }
  };

  const Header = (
    <View style={s.header}>
      <TouchableOpacity onPress={() => navigation.goBack()} style={[s.back, { backgroundColor: theme.pill, borderColor: theme.pillBorder }]} accessibilityLabel={t('common.back', { defaultValue: 'Back' })}>
        <Ionicons name="chevron-back" size={20} color={theme.foreground} />
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={[s.root, { backgroundColor: theme.background, paddingTop: insets.top }]}>
      <StatusBar barStyle={mode === 'dark' ? 'light-content' : 'dark-content'} />
      {Header}
      {state === 'loading' && <View style={s.center}><ActivityIndicator color={theme.foreground} /></View>}
      {state === 'gone' && (
        <View style={s.center}>
          <Ionicons name="alert-circle-outline" size={36} color={theme.hint} />
          <Text style={[s.h2, { color: theme.foreground }]}>{t('offers.noLongerAvailable')}</Text>
          <TouchableOpacity onPress={() => navigation.goBack()} style={[s.btn, { backgroundColor: theme.accent }]}><Text style={[s.btnTxt, { color: theme.accentFg }]}>{t('offers.backToOffers')}</Text></TouchableOpacity>
        </View>
      )}
      {state === 'error' && (
        <View style={s.center}>
          <Text style={[s.h2, { color: theme.foreground }]}>{t('offers.errorTitle')}</Text>
          <TouchableOpacity onPress={() => { setState('loading'); load(); }} style={[s.btn, { backgroundColor: theme.accent }]}><Text style={[s.btnTxt, { color: theme.accentFg }]}>{t('offers.retry')}</Text></TouchableOpacity>
        </View>
      )}
      {state === 'ready' && offer && (
        <>
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 140 }}>
            <View style={s.bankRow}>
              <BankMark bank={offer.bank} theme={theme} size={52} />
              <View style={{ flex: 1 }}>
                <Text style={[s.bank, { color: theme.hint }]}>{t('offers.fromBank', { bank: offer.bank.name })}</Text>
                <Text style={[s.title, { color: theme.foreground }]}>{offer.title}</Text>
              </View>
            </View>
            {!!offer.description && <Text style={[s.body, { color: theme.foreground }]}>{offer.description}</Text>}

            <View style={[s.panel, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Row icon="people-outline" label={t('offers.whoCanApply')} value={offer.eligibility} theme={theme} />
              {!!offer.expiresAt && <Row icon="calendar-outline" label={t('offers.validUntil')} value={expiryText(offer.expiresAt)} theme={theme} />}
              {offer.requiresBankApproval && <Row icon="shield-checkmark-outline" label={t('offers.bankDecides')} value={t('offers.bankDecidesBody')} theme={theme} />}
            </View>

            <Text style={[s.section, { color: theme.hint }]}>{t('offers.terms')}</Text>
            <Text style={[s.terms, { color: theme.muted }]}>{offer.terms}</Text>

            {!!offer.disclaimer && (
              <View style={[s.notice, { backgroundColor: theme.pill, borderColor: theme.pillBorder }]}>
                <Ionicons name="information-circle-outline" size={16} color={theme.muted} />
                <Text style={[s.noticeTxt, { color: theme.muted }]}>{offer.disclaimer}</Text>
              </View>
            )}
            <Text style={[s.privacy, { color: theme.hint }]}>{t('offers.privacy')}</Text>
          </ScrollView>

          {offer.hasAccountLink && (
            <View style={[s.cta, { paddingBottom: insets.bottom + 12, backgroundColor: theme.background, borderTopColor: theme.border }]}>
              <TouchableOpacity disabled={busy} onPress={goToBank} activeOpacity={0.85} style={[s.btnWide, { backgroundColor: theme.accent, opacity: busy ? 0.6 : 1 }]} accessibilityRole="button">
                {busy ? <ActivityIndicator color={theme.accentFg} /> : <Text style={[s.btnTxt, { color: theme.accentFg }]}>{t('offers.continueToBank', { bank: offer.bank.name })}</Text>}
              </TouchableOpacity>
            </View>
          )}
        </>
      )}
    </View>
  );
}

const Row = ({ icon, label, value, theme }) => (
  <View style={s.row}>
    <Ionicons name={icon} size={18} color={theme.muted} style={{ marginTop: 2 }} />
    <View style={{ flex: 1 }}>
      <Text style={[s.rowLabel, { color: theme.hint }]}>{label}</Text>
      <Text style={[s.rowValue, { color: theme.foreground }]}>{value}</Text>
    </View>
  </View>
);

const s = StyleSheet.create({
  root: { flex: 1 },
  header: { paddingHorizontal: 16, paddingVertical: 10 },
  back: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 10 },
  bankRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 14 },
  bank: { fontSize: 12, fontWeight: '600', marginBottom: 3 },
  title: { fontSize: 22, fontWeight: '900' },
  body: { fontSize: 15, lineHeight: 22, marginBottom: 16 },
  panel: { borderWidth: 1, borderRadius: 18, padding: 14, gap: 14 },
  row: { flexDirection: 'row', gap: 12 },
  rowLabel: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 2 },
  rowValue: { fontSize: 14, lineHeight: 20 },
  section: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 22, marginBottom: 6 },
  terms: { fontSize: 13, lineHeight: 20 },
  notice: { flexDirection: 'row', gap: 8, borderWidth: 1, borderRadius: 14, padding: 12, marginTop: 18 },
  noticeTxt: { flex: 1, fontSize: 12, lineHeight: 18 },
  privacy: { fontSize: 11, lineHeight: 16, marginTop: 14 },
  cta: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  btnWide: { height: 52, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  btn: { marginTop: 12, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 999 },
  btnTxt: { fontSize: 15, fontWeight: '800' },
  h2: { fontSize: 16, fontWeight: '800', textAlign: 'center' },
});
