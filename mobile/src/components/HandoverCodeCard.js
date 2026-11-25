// mobile/src/components/HandoverCodeCard.js — the registered sender's hand-over code (M16 §3.6).
// Shown only to the authenticated sender who owns the delivery, and only while the server still issues the code.
// Masked by default. No copy / share action, and the code is never put in a notification, log or analytics event.
import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import { showHandoverCard, maskCode, spacedCode } from '../utils/proofOfDelivery';
import { handoverEmailedNotice } from '../utils/recipientEmail';

export default function HandoverCodeCard({ delivery, theme }) {
  const { user } = useAuth();
  const [reveal, setReveal] = useState(false);
  const visible = showHandoverCard(delivery, user);
  useEffect(() => { if (!visible) setReveal(false); }, [visible]);
  if (!visible) {
    // Option B: the recipient's email carries the code, so the server sends the sender none. Say so, neutrally: no code, no address.
    const notice = handoverEmailedNotice(delivery, user);
    return notice ? (
      <View style={[st.card, { borderColor: theme.border, backgroundColor: theme.backgroundAlt }]} accessibilityLabel="Hand-over code emailed notice">
        <Text style={{ color: theme.muted, fontSize: 13 }}>{notice}</Text>
      </View>
    ) : null;
  }
  return (
    <View style={[st.card, { borderColor: theme.accent, backgroundColor: theme.accent + '12' }]} accessibilityLabel="Hand-over code card">
      <Text style={[st.label, { color: theme.hint }]}>HAND-OVER CODE</Text>
      <Text style={{ color: theme.muted, fontSize: 12, marginBottom: 8 }}>The recipient gives this code to the courier when the parcel arrives. Only tell the recipient.</Text>
      <TouchableOpacity onPress={() => setReveal((v) => !v)} accessibilityRole="button" accessibilityLabel={reveal ? 'Hide code' : 'Show code'} style={st.row}>
        <Text style={{ color: theme.foreground, fontSize: 28, fontWeight: '900', letterSpacing: 4 }}>{reveal ? spacedCode(delivery.podCode) : maskCode(delivery.podCode)}</Text>
        <Ionicons name={reveal ? 'eye-off-outline' : 'eye-outline'} size={20} color={theme.muted} />
      </TouchableOpacity>
    </View>
  );
}
const st = StyleSheet.create({ card: { borderWidth: 1, borderRadius: 16, padding: 14, marginBottom: 14 }, label: { fontSize: 11, fontWeight: '800', letterSpacing: 0.6, marginBottom: 4 }, row: { flexDirection: 'row', alignItems: 'center', gap: 10 } });
