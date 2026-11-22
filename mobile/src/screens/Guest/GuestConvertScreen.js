// mobile/src/screens/Guest/GuestConvertScreen.js — optional account creation after a guest booking (M16 §3.4).
// Never blocks booking. On success the REGISTERED session is started and the guest credentials are cleared (AuthContext.completeConversion).
import React, { useRef, useState } from 'react';
import { View, Text, TextInput, ScrollView } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { guestBookingAPI } from '../../services/api';
import { loadGuestSession } from '../../services/guestSession';
import { convertErrorMessage } from '../../utils/guestBooking';
import { Screen, Cta, Msg, ui } from './guestUi';

const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || '').trim());

export default function GuestConvertScreen({ navigation }) {
  const { theme } = useTheme();
  const { completeConversion, endGuestSession } = useAuth();
  const [first, setFirst] = useState(''); const [last, setLast] = useState('');
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(null);
  const pending = useRef(false);
  const ok = validEmail(email) && password.length >= 8;

  const submit = async () => {
    if (pending.current || !ok) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const s = await loadGuestSession();
      if (!s) { setError('Your phone verification has ended. Verify your number again to create an account.'); await endGuestSession(); return; }
      const res = await guestBookingAPI.convert(s.session, { email: email.trim(), password, firstName: first.trim() || undefined, lastName: last.trim() || undefined });
      const r = await completeConversion(res?.data);
      if (!r.success) setError(r.message);                   // success: RootScreen swaps to the signed-in app on its own
    } catch (e) { setError(convertErrorMessage(e)); }
    finally { pending.current = false; setBusy(false); }
  };

  const field = (label, value, set, props = {}) => (
    <View>
      <Text style={[ui.label, { color: theme.hint }]}>{label}</Text>
      <View style={[ui.box, { backgroundColor: theme.backgroundAlt, borderColor: theme.border }]}>
        <TextInput value={value} onChangeText={(v) => { set(v); setError(null); }} placeholderTextColor={theme.hint} style={[ui.input, { color: theme.foreground }]} accessibilityLabel={label} editable={!busy} {...props} />
      </View>
    </View>
  );

  return (
    <Screen theme={theme} title="Create your account" onBack={() => navigation.goBack()} footer={<Cta theme={theme} label="Create account" onPress={submit} busy={busy} disabled={!ok} />}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24 }}>
        <Text style={{ color: theme.muted, marginBottom: 16 }}>Keep your trips in one place, rebook faster and top up a wallet. Your verified number and this booking move to your account. You can skip this.</Text>
        {field('FIRST NAME', first, setFirst, { autoComplete: 'given-name', maxLength: 60 })}
        {field('LAST NAME', last, setLast, { autoComplete: 'family-name', maxLength: 60 })}
        {field('EMAIL', email, setEmail, { keyboardType: 'email-address', autoCapitalize: 'none', autoComplete: 'email', maxLength: 120 })}
        {field('PASSWORD (8+ CHARACTERS)', password, setPassword, { secureTextEntry: true, autoComplete: 'new-password', maxLength: 128 })}
        <Msg text={error} theme={theme} />
      </ScrollView>
    </Screen>
  );
}
