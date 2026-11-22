// mobile/src/components/ResumeTripCard.js
//
// Shown on HomeScreen right after sign-up/sign-in when the person planned a trip in the
// signed-out Trip Preview ("Boarding Pass"). Picks the journey up where they left it.
import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, Image, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { BRAND } from '../theme/theme';
import { loadTripDraft, clearTripDraft } from '../services/tripDraft';
import { resolveVehicleIconKey, vehicleIconSource } from '../utils/vehicleIcons';
import { formatMoneyFor } from '../utils/tripEstimate';

const NAMES = { TRICYCLE: 'Keke', MOTORCYCLE: 'Okada', CAR: 'Car', VAN: 'Van' };

export default function ResumeTripCard({ navigation, onContinue }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(null);

  const refresh = useCallback(async () => { setDraft(await loadTripDraft()); }, []);

  useEffect(() => {
    refresh();
    const unsub = navigation?.addListener?.('focus', refresh);
    return unsub;
  }, [navigation, refresh]);

  if (!draft) return null;

  const key = resolveVehicleIconKey(draft.vehicleType, { colour: 'blue' });
  const name = draft.countryCode === 'NG' || !draft.countryCode
    ? NAMES[draft.vehicleType] || 'Ride'
    : ({ TRICYCLE: 'Tricycle', MOTORCYCLE: 'Motorbike', CAR: 'Car', VAN: 'Van' }[draft.vehicleType] || 'Ride');

  const cont = async () => {
    await clearTripDraft();   // consumed: the real booking screen takes over from here
    setDraft(null);
    onContinue ? onContinue(draft) : navigation.navigate('RequestRide');
  };
  const dismiss = async () => { await clearTripDraft(); setDraft(null); };

  return (
    <LinearGradient colors={[BRAND.navy, '#0A4F8F', BRAND.blue]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.card}>
      <View style={s.row}>
        <View style={s.iconWrap}><Image source={vehicleIconSource(key)} style={s.icon} resizeMode="contain" /></View>
        <View style={{ flex: 1 }}>
          <Text style={s.eyebrow}>{t('tripPreview.resumeEyebrow', { defaultValue: 'YOUR PASS IS ACTIVE' })} · {draft.passCode}</Text>
          <Text style={s.title} numberOfLines={1}>{t('tripPreview.resumeTitle', { defaultValue: 'Pick up your trip where you left it' })}</Text>
          <Text style={s.meta} numberOfLines={1}>
            {name} · ~{Math.round(draft.distanceKm)} km · {formatMoneyFor(draft.fare, draft.currency)}
          </Text>
        </View>
        <TouchableOpacity onPress={dismiss} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} style={s.close}>
          <Ionicons name="close" size={16} color="rgba(255,255,255,0.7)" />
        </TouchableOpacity>
      </View>
      <TouchableOpacity activeOpacity={0.88} onPress={cont} style={s.btn}>
        <Text style={s.btnTxt}>{t('tripPreview.resumeCta', { defaultValue: 'Choose destination & book' })}</Text>
        <Ionicons name="arrow-forward" size={16} color={BRAND.navy} />
      </TouchableOpacity>
    </LinearGradient>
  );
}

const s = StyleSheet.create({
  card: { marginHorizontal: 20, marginBottom: 14, borderRadius: 20, padding: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  iconWrap: { width: 52, height: 52, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center' },
  icon: { width: 42, height: 42 },
  eyebrow: { color: BRAND.cyan, fontSize: 10, fontWeight: '800', letterSpacing: 1.6 },
  title: { color: '#FFFFFF', fontSize: 15, fontWeight: '800', marginTop: 3 },
  meta: { color: 'rgba(255,255,255,0.8)', fontSize: 12, marginTop: 2, fontWeight: '500' },
  close: { alignSelf: 'flex-start', padding: 2 },
  btn: { marginTop: 12, height: 42, borderRadius: 12, backgroundColor: '#FFFFFF', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  btnTxt: { color: BRAND.navy, fontSize: 14, fontWeight: '800' },
});
