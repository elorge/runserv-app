// mobile/src/components/DispatchStatusBanner.js — on the driver / courier dashboard. Shows only for fleet drivers who
// cannot take jobs (red) or whose vehicle document is about to expire (amber); otherwise renders nothing.
import React, { useEffect, useState, useCallback } from 'react';
import { Text, TouchableOpacity, StyleSheet, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { driverAPI, partnerAPI } from '../services/api';
import { shouldShowBanner, bannerTone } from '../utils/dispatchStatus';

export default function DispatchStatusBanner({ role = 'DRIVER', theme, onPress }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState(null);
  const api = role === 'DELIVERY_PARTNER' ? partnerAPI : driverAPI;
  const load = useCallback(() => { api.getDispatchStatus().then((r) => setStatus(r?.data ?? null)).catch(() => {}); }, [api]);
  useFocusEffect(load); // refresh whenever the dashboard regains focus, e.g. after the fleet fixes a document
  useEffect(() => { load(); }, [load]);
  if (!shouldShowBanner(status)) return null;
  const blocked = bannerTone(status) === 'blocked';
  const color = blocked ? '#E05555' : '#FFB800';
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85} accessibilityRole="button"
      style={[s.row, { backgroundColor: color + '14', borderColor: color + '55' }]}>
      <Ionicons name={blocked ? 'alert-circle-outline' : 'time-outline'} size={20} color={color} />
      <View style={{ flex: 1 }}>
        <Text style={[s.title, { color: theme.foreground }]}>{blocked ? t('dispatchStatus.bannerBlocked') : t('dispatchStatus.bannerWarning')}</Text>
        <Text style={[s.sub, { color: theme.hint }]}>{t('dispatchStatus.bannerSub')}</Text>
      </View>
      <Ionicons name="chevron-forward" size={15} color={theme.hint} />
    </TouchableOpacity>
  );
}
const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: 16, padding: 14, marginBottom: 12 },
  title: { fontSize: 14, fontWeight: '800' },
  sub: { fontSize: 12, marginTop: 1 },
});
