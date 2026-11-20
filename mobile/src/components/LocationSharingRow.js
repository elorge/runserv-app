// mobile/src/components/LocationSharingRow.js — dashboard row showing whether live-location sharing is on, and opening the
// consent screen. Refreshes whenever the dashboard regains focus (e.g. after agreeing or stopping).
import React, { useState, useCallback } from 'react';
import { Text, TouchableOpacity, StyleSheet, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { driverAPI, partnerAPI } from '../services/api';

export default function LocationSharingRow({ role = 'DRIVER', theme, onPress }) {
  const { t } = useTranslation();
  const [granted, setGranted] = useState(null);       // null = unknown (offline / loading): the row stays quiet about it
  const api = role === 'DELIVERY_PARTNER' ? partnerAPI : driverAPI;
  useFocusEffect(useCallback(() => {
    let live = true;
    api.getLocationConsent().then((r) => { if (live) setGranted(!!(r?.data?.data?.consent?.granted ?? r?.data?.consent?.granted)); }).catch(() => {});
    return () => { live = false; };
  }, [api]));
  const color = granted === false ? '#FFB800' : '#5DAA72';
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85} accessibilityRole="button"
      style={[s.row, { backgroundColor: theme.card, borderColor: granted === false ? color + '88' : theme.border }]}>
      <Ionicons name="navigate-outline" size={20} color={color} />
      <View style={{ flex: 1 }}>
        <Text style={[s.title, { color: theme.foreground }]}>{t('locationSharing.rowTitle')}</Text>
        {granted !== null ? <Text style={[s.sub, { color: theme.hint }]}>{granted ? t('locationSharing.rowOn') : t('locationSharing.rowOff')}</Text> : null}
      </View>
      <Ionicons name="chevron-forward" size={15} color={theme.hint} />
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12, marginTop: 10 },
  title: { fontSize: 14, fontWeight: '800' },
  sub: { fontSize: 12, marginTop: 1 },
});
