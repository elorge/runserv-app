// mobile/src/components/OffersEntryCard.js — a quiet row on the customer's home sheet. Renders nothing unless the
// server returns at least one offer the customer may see, so nothing appears before a campaign is approved and live.
import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { offersAPI } from '../services/api';
import { visibleOffers } from '../utils/offers';

export default function OffersEntryCard({ onPress, theme }) {
  const { t } = useTranslation();
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    offersAPI.list()
      .then((r) => { const d = r?.data ?? {}; if (alive) setCount(visibleOffers(d.offers, { creditEnabled: Boolean(d.creditOffersEnabled) }).length); })
      .catch(() => { /* an optional extra: stay hidden on any error */ });
    return () => { alive = false; };
  }, []);
  if (!count) return null;
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85} accessibilityRole="button" accessibilityLabel={t('offers.entryTitle')}
      style={[s.row, { backgroundColor: theme.pill, borderColor: theme.pillBorder }]}>
      <Ionicons name="gift-outline" size={18} color={theme.foreground} />
      <View style={{ flex: 1 }}>
        <Text style={[s.title, { color: theme.foreground }]}>{t('offers.entryTitle')}</Text>
        <Text style={[s.sub, { color: theme.hint }]}>{t('offers.entrySub', { count })}</Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={theme.hint} />
    </TouchableOpacity>
  );
}
const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12, marginTop: 10 },
  title: { fontSize: 14, fontWeight: '800' },
  sub: { fontSize: 12, marginTop: 1 },
});
