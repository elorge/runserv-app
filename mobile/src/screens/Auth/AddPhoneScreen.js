// mobile/src/screens/Auth/AddPhoneScreen.js
// People who signed up with Google add and verify a phone number before using the app
// (drivers and riders need to be able to call each other).
import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, KeyboardAvoidingView, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { authAPI } from '../../services/api';

export default function AddPhoneScreen() {
  const { theme } = useTheme();
  const { user, updateUser, logout } = useAuth();
  const insets = useSafeAreaInsets();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [session, setSession] = useState(null);     // { tempToken, phoneToken, maskedContact }
  const [busy, setBusy] = useState(false);

  const send = async () => {
    setBusy(true);
    try { const r = await authAPI.requestPhone({ phone: phone.trim(), countryCode: user?.countryCode }); setSession(r.data); }
    catch (e) { Alert.alert('Could not send the code', e?.response?.data?.message ?? e?.message ?? 'Check the number and try again.'); }
    finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true);
    try { const r = await authAPI.verifyPhone({ code: code.trim(), tempToken: session.tempToken, phoneToken: session.phoneToken }); await updateUser({ phone: r.data.user.phone }); }
    catch (e) { Alert.alert('Wrong code', e?.response?.data?.message ?? 'Check the code and try again.'); }
    finally { setBusy(false); }
  };

  return (
    <KeyboardAvoidingView style={[st.root, { backgroundColor: theme.background, paddingTop: insets.top + 40 }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[st.icon, { backgroundColor: theme.accent + '22' }]}><Ionicons name="call-outline" size={30} color={theme.accent} /></View>
      <Text style={[st.h1, { color: theme.foreground }]}>{session ? 'Enter the code' : 'Add your phone number'}</Text>
      <Text style={[st.p, { color: theme.hint }]}>
        {session ? `We sent a 6-digit code to ${session.maskedContact}.` : 'Drivers and delivery partners call you about pick-ups, so we need a number that reaches you.'}
      </Text>

      {!session ? (
        <TextInput value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="e.g. 0801 234 5678" placeholderTextColor={theme.hint} autoFocus
          style={[st.input, { color: theme.foreground, borderColor: theme.border, backgroundColor: theme.backgroundAlt }]} />
      ) : (
        <TextInput value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} placeholder="••••••" placeholderTextColor={theme.hint} autoFocus
          style={[st.input, st.code, { color: theme.foreground, borderColor: theme.border, backgroundColor: theme.backgroundAlt }]} />
      )}

      <TouchableOpacity onPress={session ? verify : send} disabled={busy || (session ? code.length < 4 : phone.trim().length < 7)} activeOpacity={0.85}
        style={[st.btn, { backgroundColor: theme.accent, opacity: busy || (session ? code.length < 4 : phone.trim().length < 7) ? 0.5 : 1 }]}>
        {busy ? <ActivityIndicator color={theme.accentFg} /> : <Text style={[st.btnTxt, { color: theme.accentFg }]}>{session ? 'Verify' : 'Send code'}</Text>}
      </TouchableOpacity>
      {session && <TouchableOpacity onPress={() => { setSession(null); setCode(''); }}><Text style={[st.link, { color: theme.accent }]}>Use a different number</Text></TouchableOpacity>}
      <TouchableOpacity onPress={logout} style={{ marginTop: 28 }}><Text style={[st.link, { color: theme.hint }]}>Sign out</Text></TouchableOpacity>
    </KeyboardAvoidingView>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 24, alignItems: 'stretch' },
  icon: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', alignSelf: 'center', marginBottom: 18 },
  h1: { fontSize: 24, fontWeight: '800', textAlign: 'center' }, p: { fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: 8, marginBottom: 26 },
  input: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14, fontSize: 17, marginBottom: 16 },
  code: { textAlign: 'center', letterSpacing: 8, fontSize: 24, fontWeight: '700' },
  btn: { borderRadius: 14, paddingVertical: 15, alignItems: 'center' }, btnTxt: { fontSize: 16, fontWeight: '700' },
  link: { textAlign: 'center', marginTop: 16, fontSize: 14, fontWeight: '600' },
});
