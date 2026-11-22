// Small shared pieces for the guest screens (M16). Presentation only.
import React from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export const RED = '#DC2626';

export function Screen({ theme, title, onBack, children, footer }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: theme.background }}>
      <View style={[ui.top, { paddingTop: insets.top + 8 }]}>
        {onBack ? (
          <TouchableOpacity onPress={onBack} accessibilityRole="button" accessibilityLabel="Back" style={[ui.back, { borderColor: theme.border, backgroundColor: theme.backgroundAlt }]}>
            <Ionicons name="chevron-back" size={18} color={theme.foreground} />
          </TouchableOpacity>
        ) : <View style={{ width: 36 }} />}
        <Text accessibilityRole="header" style={[ui.title, { color: theme.foreground }]}>{title}</Text>
        <View style={{ width: 36 }} />
      </View>
      {children}
      {footer ? <View style={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 12, paddingTop: 8 }}>{footer}</View> : null}
    </View>
  );
}

export function Cta({ theme, label, onPress, busy, disabled, tone = 'primary' }) {
  const off = disabled || busy;
  const bg = tone === 'primary' ? theme.accent : theme.backgroundAlt;
  return (
    <TouchableOpacity onPress={onPress} disabled={off} accessibilityRole="button" accessibilityState={{ disabled: off, busy: !!busy }}
      style={[ui.cta, { backgroundColor: bg, borderWidth: tone === 'primary' ? 0 : 1, borderColor: theme.border, opacity: off ? 0.5 : 1 }]}>
      {busy ? <ActivityIndicator color={tone === 'primary' ? '#fff' : theme.accent} /> : <Text style={{ color: tone === 'primary' ? '#fff' : theme.foreground, fontWeight: '800', fontSize: 15 }}>{label}</Text>}
    </TouchableOpacity>
  );
}

export const Msg = ({ text, theme, tone = 'error' }) => (text ? <Text accessibilityLiveRegion="polite" style={{ color: tone === 'error' ? RED : theme.muted, fontSize: 13, marginTop: 8 }}>{text}</Text> : null);

export const Row = ({ theme, label, value }) => (
  <View style={ui.row}><Text style={{ color: theme.hint, fontSize: 12, flex: 0.9 }}>{label}</Text><Text style={{ color: theme.foreground, fontWeight: '700', flex: 2, textAlign: 'right' }} numberOfLines={3}>{value}</Text></View>
);

export const ui = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 8 },
  back: { width: 36, height: 36, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 17, fontWeight: '800' },
  cta: { borderRadius: 14, paddingVertical: 15, alignItems: 'center', justifyContent: 'center', minHeight: 50 },
  box: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1.5, borderRadius: 14, paddingHorizontal: 12, minHeight: 50, marginBottom: 10 },
  input: { flex: 1, fontSize: 16, paddingVertical: 10 },
  label: { fontSize: 11, fontWeight: '800', letterSpacing: 0.6, marginBottom: 6 },
  card: { borderWidth: 1, borderRadius: 16, padding: 14, marginBottom: 12 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 6 },
});
