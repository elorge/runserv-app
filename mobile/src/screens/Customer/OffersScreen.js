// mobile/src/screens/Customer/OffersScreen.js — sponsored offers from partner banks (blueprint §6).
// The server decides what may be shown (approved, in-window, funded, active bank). This screen only renders it,
// reports which offers were actually seen, and never invents a claim the server did not send.
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, FlatList, RefreshControl, ActivityIndicator, Image, StatusBar } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../context/ThemeContext';
import { offersAPI } from '../../services/api';
import { visibleOffers, expiryKey } from '../../utils/offers';

export const useExpiryText = () => {
  const { t, i18n } = useTranslation();
  return (expiresAt) => {
    const e = expiryKey(expiresAt);
    if (!e) return '';
    if (e.key === 'offers.endsOn') return t(e.key, { date: e.date.toLocaleDateString(i18n.language, { day: 'numeric', month: 'short', year: 'numeric' }) });
    return t(e.key, { count: e.count });
  };
};

const BankMark = ({ bank, theme, size = 40 }) => {
  const [failed, setFailed] = useState(false);
  if (bank?.logoUrl && !failed) {
    return <Image source={{ uri: bank.logoUrl }} onError={() => setFailed(true)} style={{ width: size, height: size, borderRadius: size / 4, backgroundColor: theme.pill }} resizeMode="contain" accessibilityIgnoresInvertColors />;
  }
  return (
    <View style={{ width: size, height: size, borderRadius: size / 4, backgroundColor: theme.pill, alignItems: 'center', justifyContent: 'center' }}>
      <Ionicons name="business-outline" size={size * 0.5} color={theme.muted} />
    </View>
  );
};
export { BankMark };

const OfferCard = ({ offer, onPress, theme, expiryText }) => (
  <TouchableOpacity activeOpacity={0.85} onPress={() => onPress(offer)} style={[s.card, { backgroundColor: theme.card, borderColor: theme.border }]}
    accessibilityRole="button" accessibilityLabel={`${offer.bank.name}. ${offer.title}`}>
    <View style={s.cardTop}>
      <BankMark bank={offer.bank} theme={theme} />
      <View style={{ flex: 1 }}>
        <Text style={[s.bank, { color: theme.hint }]} numberOfLines={1}>{offer.bank.name}</Text>
        <Text style={[s.title, { color: theme.foreground }]} numberOfLines={2}>{offer.title}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={theme.hint} />
    </View>
    {!!offer.description && <Text style={[s.desc, { color: theme.muted }]} numberOfLines={3}>{offer.description}</Text>}
    <View style={s.metaRow}>
      <View style={[s.chip, { backgroundColor: theme.pill, borderColor: theme.pillBorder }]}>
        <Ionicons name="people-outline" size={12} color={theme.muted} />
        <Text style={[s.chipTxt, { color: theme.muted }]} numberOfLines={1}>{offer.eligibility}</Text>
      </View>
      {!!expiryText && <Text style={[s.expiry, { color: theme.hint }]}>{expiryText}</Text>}
    </View>
  </TouchableOpacity>
);

export default function OffersScreen({ navigation }) {
  const { theme, mode } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const expiryText = useExpiryText();
  const [offers, setOffers] = useState([]);
  const [state, setState] = useState('loading'); // loading | ready | error | unavailable
  const [refreshing, setRefreshing] = useState(false);
  const seen = useRef(new Set()); // reported once per screen visit; the server also de-duplicates per hour

  const load = useCallback(async (pull = false) => {
    if (pull) setRefreshing(true);
    try {
      const res = await offersAPI.list();
      const d = res?.data ?? {};
      setOffers(visibleOffers(d.offers, { creditEnabled: Boolean(d.creditOffersEnabled) }));
      setState('ready');
    } catch (e) {
      setState(e?.response?.status === 404 || e?.statusCode === 404 ? 'unavailable' : 'error');
    } finally { setRefreshing(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const onViewable = useRef(({ viewableItems }) => {
    const fresh = viewableItems.map((v) => v.item?.id).filter((id) => id && !seen.current.has(id));
    if (!fresh.length) return;
    fresh.forEach((id) => seen.current.add(id));
    offersAPI.impressions(fresh.slice(0, 20)).catch(() => { fresh.forEach((id) => seen.current.delete(id)); }); // analytics must never disturb the screen
  }).current;
  const viewConfig = useRef({ itemVisiblePercentThreshold: 60, minimumViewTime: 600 }).current;

  return (
    <View style={[s.root, { backgroundColor: theme.background, paddingTop: insets.top }]}>
      <StatusBar barStyle={mode === 'dark' ? 'light-content' : 'dark-content'} />
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={[s.back, { backgroundColor: theme.pill, borderColor: theme.pillBorder }]} accessibilityLabel={t('common.back', { defaultValue: 'Back' })}>
          <Ionicons name="chevron-back" size={20} color={theme.foreground} />
        </TouchableOpacity>
        <Text style={[s.h1, { color: theme.foreground }]}>{t('offers.title')}</Text>
        <View style={{ width: 40 }} />
      </View>

      {state === 'loading' ? (
        <View style={s.center}><ActivityIndicator color={theme.foreground} /></View>
      ) : state === 'error' ? (
        <View style={s.center}>
          <Ionicons name="cloud-offline-outline" size={36} color={theme.hint} />
          <Text style={[s.emptyTitle, { color: theme.foreground }]}>{t('offers.errorTitle')}</Text>
          <Text style={[s.emptySub, { color: theme.hint }]}>{t('offers.errorSub')}</Text>
          <TouchableOpacity onPress={() => { setState('loading'); load(); }} style={[s.btn, { backgroundColor: theme.accent }]}>
            <Text style={[s.btnTxt, { color: theme.accentFg }]}>{t('offers.retry')}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={offers}
          keyExtractor={(o) => o.id}
          renderItem={({ item }) => <OfferCard offer={item} theme={theme} expiryText={expiryText(item.expiresAt)} onPress={(o) => navigation.navigate('OfferDetail', { offerId: o.id, offer: o })} />}
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 90, flexGrow: 1 }}
          ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={theme.foreground} />}
          onViewableItemsChanged={onViewable}
          viewabilityConfig={viewConfig}
          ListHeaderComponent={offers.length ? <Text style={[s.intro, { color: theme.hint }]}>{t('offers.intro')}</Text> : null}
          ListEmptyComponent={
            <View style={s.center}>
              <Ionicons name="gift-outline" size={36} color={theme.hint} />
              <Text style={[s.emptyTitle, { color: theme.foreground }]}>{state === 'unavailable' ? t('offers.unavailableTitle') : t('offers.emptyTitle')}</Text>
              <Text style={[s.emptySub, { color: theme.hint }]}>{state === 'unavailable' ? t('offers.unavailableSub') : t('offers.emptySub')}</Text>
            </View>
          }
          ListFooterComponent={offers.length ? <Text style={[s.foot, { color: theme.hint }]}>{t('offers.footer')}</Text> : null}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10 },
  back: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth },
  h1: { fontSize: 18, fontWeight: '800' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
  intro: { fontSize: 13, lineHeight: 18, marginBottom: 12 },
  card: { borderWidth: 1, borderRadius: 18, padding: 14, gap: 10 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  bank: { fontSize: 12, fontWeight: '600', marginBottom: 2 },
  title: { fontSize: 16, fontWeight: '800' },
  desc: { fontSize: 13, lineHeight: 18 },
  metaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, flexShrink: 1 },
  chipTxt: { fontSize: 11, fontWeight: '600', flexShrink: 1 },
  expiry: { fontSize: 11, fontWeight: '600' },
  emptyTitle: { fontSize: 16, fontWeight: '800', textAlign: 'center', marginTop: 8 },
  emptySub: { fontSize: 13, lineHeight: 19, textAlign: 'center' },
  btn: { marginTop: 12, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 999 },
  btnTxt: { fontSize: 14, fontWeight: '800' },
  foot: { fontSize: 11, lineHeight: 16, textAlign: 'center', marginTop: 16 },
});
