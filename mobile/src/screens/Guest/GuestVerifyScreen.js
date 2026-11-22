// mobile/src/screens/Guest/GuestVerifyScreen.js — guest verification (M16 §3.2; M16.1: EMAIL code, phone is an unverified contact).
// Uses the GUEST OTP endpoints (not the registered-account 2FA screen). Never logs the code or the session.
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, ScrollView, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { guestAPI } from '../../services/api';
import { loadGuestSession } from '../../services/guestSession';
import { cleanPhoneInput, cleanEmailInput, looksLikeEmail, looksLikePhone, isOtpCode, otpErrorMessage, formatCountdown } from '../../utils/guestBooking';
import { Screen, Cta, Msg, ui } from './guestUi';

export default function GuestVerifyScreen({ navigation, route }) {
  const { theme } = useTheme();
  const { adoptSession } = useAuth();
  const bundle = route.params?.bundle || {};
  const countryCode = bundle.countryCode || 'NG';

  const resumeBookingId = route.params?.resumeBookingId || null;   // set when an expired session is being re-verified: we return to THAT booking
  const [stage, setStage] = useState('details');          // 'details' | 'code'
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [masked, setMasked] = useState('');
  const [expiresIn, setExpiresIn] = useState(0);
  const [cooldown, setCooldown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [checking, setChecking] = useState(true);
  const pending = useRef(false);                          // blocks double submits even before state updates render

  // Already verified recently? Skip straight to the confirmation.
  useEffect(() => {
    let alive = true;
    loadGuestSession().then((s) => { if (alive && s) { if (resumeBookingId) navigation.replace('GuestStatus', { bookingId: resumeBookingId }); else navigation.replace('GuestConfirm', { bundle }); } else if (alive) setChecking(false); }).catch(() => alive && setChecking(false));
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (stage !== 'code') return undefined;
    const id = setInterval(() => { setCooldown((c) => Math.max(0, c - 1)); setExpiresIn((e) => Math.max(0, e - 1)); }, 1000);
    return () => clearInterval(id);
  }, [stage]);

  const guard = async (fn) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try { await fn(); } finally { pending.current = false; setBusy(false); }
  };

  const fail = (e) => {
    const r = otpErrorMessage(e);
    setError(r);
    if (r.action === 'RESEND') setCode('');
    if (r.action === 'RETRY_CODE') setCode('');
  };

  const send = () => guard(async () => {
    try {
      const res = await guestAPI.requestOtp({ email: cleanEmailInput(email), phone: cleanPhoneInput(phone), countryCode });
      const d = res?.data || {};
      setMasked(d.email || ''); setExpiresIn(Number(d.expiresInS) || 300); setCooldown(Number(d.resendAfterS) || 60);
      setCode(''); setStage('code');
    } catch (e) { fail(e); }
  });

  const verify = () => guard(async () => {
    try {
      const res = await guestAPI.verifyOtp({ email: cleanEmailInput(email), code });
      const adopted = await adoptSession(res?.data);
      // Not adopted = the credential could not be stored: stay on this screen with the code step intact (nothing is pretended).
      if (!adopted.success) { setError({ text: adopted.message || 'Could not start your session.', action: 'NONE' }); return; }
      if (resumeBookingId) navigation.replace('GuestStatus', { bookingId: resumeBookingId }); else navigation.replace('GuestConfirm', { bundle });
    } catch (e) { fail(e); }
  });

  if (checking) return <Screen theme={theme} title="Verify your email" onBack={() => navigation.goBack()}><View /></Screen>;

  return (
    <Screen theme={theme} title="Verify your email" onBack={() => (stage === 'code' ? setStage('details') : navigation.goBack())}
      footer={stage === 'details'
        ? <Cta theme={theme} label="Send code" onPress={send} busy={busy} disabled={!looksLikeEmail(email) || !looksLikePhone(phone)} />
        : <Cta theme={theme} label="Verify and continue" onPress={verify} busy={busy} disabled={!isOtpCode(code) || expiresIn === 0} />}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24 }}>
        <Text style={{ color: theme.muted, marginBottom: 16 }}>
          {stage === 'details' ? 'We email a 6-digit code to confirm it is you. No account or password needed. Your phone number is only used to contact you about this booking.' : `If ${masked || 'that address'} is valid, a code is on its way. Check your inbox and spam or junk folder. It can take a minute.`}
        </Text>

        {stage === 'details' ? (
          <>
            <Text style={[ui.label, { color: theme.hint }]}>EMAIL ADDRESS</Text>
            <View style={[ui.box, { backgroundColor: theme.backgroundAlt, borderColor: error ? '#DC2626' : theme.border }]}>
              <Ionicons name="mail-outline" size={18} color={theme.muted} />
              <TextInput value={email} onChangeText={(v) => { setEmail(v.trim()); setError(null); }} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email" textContentType="emailAddress"
                placeholder="you@example.com" placeholderTextColor={theme.hint} style={[ui.input, { color: theme.foreground }]} accessibilityLabel="Email address" maxLength={254} editable={!busy} />
            </View>
            <Text style={[ui.label, { color: theme.hint, marginTop: 14 }]}>CONTACT PHONE NUMBER</Text>
            <View style={[ui.box, { backgroundColor: theme.backgroundAlt, borderColor: error ? '#DC2626' : theme.border }]}>
              <Ionicons name="call-outline" size={18} color={theme.muted} />
              <TextInput value={phone} onChangeText={(v) => { setPhone(cleanPhoneInput(v)); setError(null); }} keyboardType="phone-pad" autoComplete="tel" textContentType="telephoneNumber"
                placeholder="e.g. 0801 234 5678" placeholderTextColor={theme.hint} style={[ui.input, { color: theme.foreground }]} accessibilityLabel="Phone number" maxLength={20} editable={!busy} />
            </View>
          </>
        ) : (
          <>
            <Text style={[ui.label, { color: theme.hint }]}>6-DIGIT CODE</Text>
            <View style={[ui.box, { backgroundColor: theme.backgroundAlt, borderColor: error ? '#DC2626' : theme.border }]}>
              <Ionicons name="keypad-outline" size={18} color={theme.muted} />
              <TextInput value={code} onChangeText={(v) => { setCode(v.replace(/\D/g, '').slice(0, 6)); setError(null); }} keyboardType="number-pad" autoComplete="sms-otp" textContentType="oneTimeCode"
                placeholder="••••••" placeholderTextColor={theme.hint} style={[ui.input, { color: theme.foreground, letterSpacing: 6, fontWeight: '800' }]} accessibilityLabel="Verification code" maxLength={6} editable={!busy} secureTextEntry={false} />
            </View>
            <Text style={{ color: expiresIn > 0 ? theme.hint : '#DC2626', fontSize: 12 }}>{expiresIn > 0 ? `Code expires in ${formatCountdown(expiresIn)}` : 'This code has expired. Request a new one.'}</Text>
            <TouchableOpacity onPress={send} disabled={busy || cooldown > 0} accessibilityRole="button" style={{ marginTop: 14, opacity: busy || cooldown > 0 ? 0.5 : 1 }}>
              <Text style={{ color: theme.accent, fontWeight: '800' }}>{cooldown > 0 ? `Resend code in ${cooldown}s` : 'Resend code'}</Text>
            </TouchableOpacity>
          </>
        )}

        <Msg text={error?.text} theme={theme} />
        {error?.action === 'SIGNIN' ? <TouchableOpacity onPress={() => navigation.navigate('Login')} accessibilityRole="button"><Text style={{ color: theme.accent, fontWeight: '800', marginTop: 10 }}>Sign in</Text></TouchableOpacity> : null}
        <Text style={{ color: theme.hint, fontSize: 11, marginTop: 20 }}>We use your email only to verify you, and your phone only to coordinate this booking.</Text>
      </ScrollView>
    </Screen>
  );
}
