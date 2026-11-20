// mobile/src/components/OrgBilledStrip.js
// Shown to drivers / delivery partners on company-paid requests: no wallet balance is needed to
// accept, no cash is collected, and the earnings arrive with the monthly company settlement.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export const OrgBilledStrip = ({ theme, name, color = '#2563EB' }) => (
  <View style={[st.wrap, { borderColor: color + '40', backgroundColor: color + '12' }]}>
    <Ionicons name="business" size={18} color={color} />
    <View style={{ flex: 1 }}>
      <Text style={[st.title, { color: theme.foreground }]}>Company ride{name ? ` · ${name}` : ''}</Text>
      <Text style={[st.sub, { color: theme.hint }]}>
        No wallet balance needed. Don’t collect cash — you’re paid with the company’s monthly settlement.
      </Text>
    </View>
  </View>
);

const st = StyleSheet.create({
  wrap:  { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 14, padding: 12, marginBottom: 12 },
  title: { fontSize: 14, fontWeight: '700' },
  sub:   { fontSize: 11.5, marginTop: 2, lineHeight: 16 },
});
