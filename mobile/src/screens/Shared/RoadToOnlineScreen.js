// mobile/src/screens/Shared/RoadToOnlineScreen.js
//
// "Road to online": everything between a new driver's / courier's sign-up and their first trip, as one road they can leave
// and come back to. Steps are derived from the server profile (see utils/roadToOnline.js), so this always agrees with the
// admin app's approval flow. Also shows the Driver / Courier Pass they activated at sign-up.
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, RefreshControl, StyleSheet, StatusBar } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { BRAND } from '../../theme/theme';
import useRoadToOnline from '../../hooks/useRoadToOnline';
import { RoadList, ProgressRing, headlineText, planText, RED } from '../../components/earn/RoadToOnline';
import { DRIVER_ACCENT, COURIER_ACCENT } from '../../components/earn/EarnerPass';
import { loadEarnerDraft, clearEarnerDraft } from '../../services/earnerDraft';
import { formatMoneyFor } from '../../utils/tripEstimate';
import { stepTarget } from '../../utils/roadToOnline';
import { useEarnT } from '../../i18n/earnerStrings';

export default function RoadToOnlineScreen({ navigation }) {
  const { theme } = useTheme();
  const { user } = useAuth();
  const { t } = useTranslation();
  const e = useEarnT(t);
  const insets = useSafeAreaInsets();
  const role = user?.role === 'DELIVERY_PARTNER' ? 'DELIVERY_PARTNER' : 'DRIVER';
  const accent = role === 'DRIVER' ? DRIVER_ACCENT : COURIER_ACCENT;
  const { road, vehicleType, loading, error, refresh } = useRoadToOnline(role);
  const [draft, setDraft] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => { setDraft(await loadEarnerDraft()); refresh(); }, [refresh]);
  useEffect(() => {
    load();
    return navigation.addListener('focus', load);
  }, [navigation, load]);

  const onStep = (s) => { const target = stepTarget(role, s.id); if (target) navigation.navigate(target); };
  const line = planText(e, draft, role, formatMoneyFor);
  const blocked = road?.headline === 'blocked';
  const sub = road ? e({ blocked: 'roadSubBlocked', action: 'roadSubAction', waiting: 'roadSubWaiting', done: 'roadSubDone' }[road.headline]) : '';

  return (
    <View style={[st.root, { backgroundColor: theme.background }]}>
      <StatusBar barStyle={theme.mode === 'dark' ? 'light-content' : 'dark-content'} />
      <View style={[st.top, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} accessibilityRole="button" accessibilityLabel={e('back')}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} style={[st.back, { borderColor: theme.border, backgroundColor: theme.backgroundAlt }]}>
          <Ionicons name="chevron-back" size={18} color={theme.foreground} />
        </TouchableOpacity>
        <Text accessibilityRole="header" style={[st.title, { color: theme.foreground }]}>{e('roadTitle')}</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={accent} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
      >
        {road && (
          <View style={st.hero}>
            <ProgressRing size={76} stroke={7} done={road.doneCount} total={road.total} color={blocked ? RED : accent} track={theme.border} textColor={theme.foreground}
              label={e('roadProgress', { done: road.doneCount, total: road.total })} />
            <View style={{ flex: 1 }}>
              <Text style={[st.headline, { color: theme.foreground }]}>{headlineText(e, road)}</Text>
              <Text style={[st.sub, { color: theme.muted }]}>{sub}</Text>
            </View>
          </View>
        )}

        {!!draft && !!line && (
          <LinearGradient
            colors={role === 'DRIVER' ? [BRAND.navy, '#064E3B', '#10B981'] : [BRAND.navy, '#6B3F02', '#F59E0B']}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={st.pass}
          >
            <View style={{ flex: 1 }}>
              <Text style={st.passEyebrow}>{draft.passCode}</Text>
              <Text style={st.passTitle}>{role === 'DRIVER' ? e('roadPassActiveDriver') : e('roadPassActiveCourier')}</Text>
              <Text style={st.passLine}>{line}</Text>
            </View>
            <TouchableOpacity onPress={async () => { await clearEarnerDraft(); setDraft(null); }} accessibilityRole="button" accessibilityLabel={e('roadPassDismiss')}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={18} color="rgba(255,255,255,0.75)" />
            </TouchableOpacity>
          </LinearGradient>
        )}

        {error && (
          <TouchableOpacity onPress={refresh} style={[st.err, { borderColor: theme.border, backgroundColor: theme.backgroundAlt }]} accessibilityRole="button">
            <Ionicons name="cloud-offline-outline" size={16} color={theme.hint} />
            <Text style={[st.errTxt, { color: theme.muted }]}>{e('roadLoadError')} <Text style={{ color: accent, fontWeight: '700' }}>{e('roadRetry')}</Text></Text>
          </TouchableOpacity>
        )}

        {road ? (
          <RoadList role={role} road={road} accent={accent} theme={theme} e={e} vehicleType={vehicleType} onStep={onStep} />
        ) : (
          !loading && null
        )}
        <Text style={[st.foot, { color: theme.hint }]}>{e('roadFoot')}</Text>
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingBottom: 6 },
  back: { width: 32, height: 32, borderRadius: 16, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 20, fontWeight: '800' },
  hero: { flexDirection: 'row', alignItems: 'center', gap: 16, marginBottom: 18, marginTop: 6 },
  headline: { fontSize: 24, fontWeight: '800', letterSpacing: -0.4 },
  sub: { fontSize: 13.5, lineHeight: 19, marginTop: 4 },
  pass: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 18, padding: 14, marginBottom: 18 },
  passEyebrow: { color: 'rgba(255,255,255,0.8)', fontSize: 11, fontWeight: '800', letterSpacing: 2 },
  passTitle: { color: '#FFFFFF', fontSize: 16, fontWeight: '800', marginTop: 3 },
  passLine: { color: 'rgba(255,255,255,0.88)', fontSize: 12.5, marginTop: 3 },
  err: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 12, padding: 10, marginBottom: 14 },
  errTxt: { flex: 1, fontSize: 12.5 },
  foot: { fontSize: 12, lineHeight: 17, textAlign: 'center', marginTop: 8 },
});
