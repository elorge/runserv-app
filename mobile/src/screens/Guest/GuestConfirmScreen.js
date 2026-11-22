// mobile/src/screens/Guest/GuestConfirmScreen.js — review and confirm a guest booking (M16 §3.4).
// The fare is the SERVER-signed quote, passed through untouched. One idempotency key per attempt, saved BEFORE the request is sent,
// so a double tap, dropped connection or app restart returns the original booking instead of booking twice.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TextInput, ScrollView, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { guestBookingAPI } from '../../services/api';
import { loadGuestSession, loadAttempt, saveAttempt, clearAttempt, saveLastBooking, loadLastBooking } from '../../services/guestSession';
import { buildBookingBody, attemptFor, bookingErrorMessage, validateParcelForm, cleanPhoneInput } from '../../utils/guestBooking';
import { secondsLeft, formatKm, formatMinutes } from '../../utils/guestPlanner';
import { formatMoneyFor } from '../../utils/tripEstimate';
import { Screen, Cta, Msg, Row, ui } from './guestUi';

const VEHICLE = { CAR: 'Car', MOTORCYCLE: 'Bike', VAN: 'Van', TRICYCLE: 'Keke' };

export default function GuestConfirmScreen({ navigation, route }) {
  const { theme } = useTheme();
  const { endGuestSession } = useAuth();
  const b = route.params?.bundle || {};
  const isParcel = b.service === 'PARCEL';

  const [contactName, setContactName] = useState('');
  const [notes, setNotes] = useState('');
  const [parcel, setParcel] = useState({ description: '', recipientName: '', recipientPhone: '', recipientEmail: '', acknowledged: false });
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(Date.now());
  const pending = useRef(false);

  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  const left = secondsLeft(b.quote?.expiresAt, now);
  const form = useMemo(() => (isParcel ? validateParcelForm(parcel) : { ok: true, errors: {} }), [isParcel, parcel]);
  const fare = formatMoneyFor(b.fare, b.currency);

  const submit = async () => {
    if (pending.current) return;
    if (!form.ok) { setShowErrors(true); return; }
    pending.current = true; setBusy(true); setError(null);
    try {
      const session = await loadGuestSession();
      if (!session) { await endGuestSession(); navigation.replace('GuestVerify', { bundle: b }); return; }
      const body = buildBookingBody({ quote: b.quote, pickup: b.pickup, destination: b.destination, contactName, notes, service: b.service, parcel: { ...(b.parcel || {}), ...parcel } });
      const attempt = attemptFor(body, await loadAttempt());
      if (!attempt.reused) await saveAttempt(attempt);                  // persisted BEFORE sending
      const res = await guestBookingAPI.create(session.session, attempt.key, body);
      const data = res?.data;
      if (!data?.booking?.id) throw Object.assign(new Error('bad response'), { status: 502 });
      await saveLastBooking(data.booking.id); await clearAttempt();
      navigation.replace('GuestStatus', { bookingId: data.booking.id, initial: data, justBooked: true });
    } catch (e) {
      const r = bookingErrorMessage(e);
      if (r.action === 'NEW_ATTEMPT') await clearAttempt();
      if (r.action === 'REVERIFY') { await endGuestSession(); }
      setError(r);
    } finally { pending.current = false; setBusy(false); }
  };

  const onAction = async () => {
    const a = error?.action;
    if (a === 'REQUOTE') navigation.navigate('TripPlanner');
    else if (a === 'REVERIFY') navigation.replace('GuestVerify', { bundle: b });
    else if (a === 'SIGNIN') navigation.navigate('Login');
    else if (a === 'OPEN_ACTIVE') { const id = await loadLastBooking(); if (id) navigation.replace('GuestStatus', { bookingId: id }); }
    else if (a === 'RETRY' || a === 'NEW_ATTEMPT' || a === 'FIX' || a === 'WAIT') { setError(null); if (a === 'RETRY') submit(); }
  };
  const actionLabel = { REQUOTE: 'Get a fresh price', REVERIFY: 'Verify my number', SIGNIN: 'Sign in', OPEN_ACTIVE: 'Open my trip', RETRY: 'Try again', NEW_ATTEMPT: 'Review and confirm', FIX: 'Edit details', WAIT: 'OK' }[error?.action];

  const f = (key, label, props = {}) => (
    <View key={key}>
      <Text style={[ui.label, { color: theme.hint }]}>{label}</Text>
      <View style={[ui.box, { backgroundColor: theme.backgroundAlt, borderColor: showErrors && form.errors[key] ? '#DC2626' : theme.border }]}>
        <TextInput value={String(parcel[key] ?? '')} onChangeText={(v) => setParcel((p) => ({ ...p, [key]: v }))} placeholderTextColor={theme.hint} style={[ui.input, { color: theme.foreground }]} accessibilityLabel={label} editable={!busy} {...props} />
      </View>
      {showErrors && form.errors[key] ? <Msg text={form.errors[key]} theme={theme} /> : null}
    </View>
  );

  return (
    <Screen theme={theme} title="Confirm booking" onBack={() => navigation.goBack()}
      footer={(
        <>
          <Cta theme={theme} label={isParcel ? `Book courier · ${fare}` : `Book ride · ${fare}`} onPress={submit} busy={busy} disabled={!b.quote || left <= 0 || busy} />
          <Text style={{ color: theme.hint, fontSize: 11, textAlign: 'center', marginTop: 6 }}>{left > 0 ? `Price held for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'This price has expired.'}</Text>
        </>
      )}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24 }}>
        <View style={[ui.card, { borderColor: theme.border, backgroundColor: theme.backgroundAlt }]}>
          <Row theme={theme} label="Service" value={isParcel ? 'Parcel delivery' : 'Ride'} />
          <Row theme={theme} label="Vehicle" value={VEHICLE[b.vehicleType] || b.vehicleType || ''} />
          <Row theme={theme} label="Pickup" value={b.pickup?.label} />
          <Row theme={theme} label={isParcel ? 'Drop-off' : 'Destination'} value={b.destination?.label} />
          {b.distanceM ? <Row theme={theme} label="Distance" value={`${formatKm(b.distanceM)} · ≈ ${formatMinutes(b.durationS)}`} /> : null}
          <Row theme={theme} label="Fare" value={fare} />
          <Row theme={theme} label="Payment" value={isParcel ? 'Cash to the courier' : 'Cash to the driver'} />
        </View>
        <Text style={{ color: theme.hint, fontSize: 12, marginBottom: 14 }}>The fare is the price we quoted for this route. You will get a booking reference and can share the tracking link on the next screen.</Text>

        {isParcel ? (
          <>
            {f('description', 'WHAT IS IN THE PARCEL', { placeholder: 'e.g. Documents, a phone charger', maxLength: 120 })}
            {f('recipientName', 'RECIPIENT NAME', { placeholder: 'Who receives it', maxLength: 60 })}
            {f('recipientPhone', 'RECIPIENT PHONE', { placeholder: 'The courier may call this number', keyboardType: 'phone-pad', maxLength: 20, onChangeText: (v) => setParcel((p) => ({ ...p, recipientPhone: cleanPhoneInput(v) })) })}
            {f('recipientEmail', 'RECIPIENT EMAIL', { placeholder: 'We email them the hand-over code and tracking link', keyboardType: 'email-address', autoCapitalize: 'none', autoCorrect: false, autoComplete: 'email', maxLength: 254 })}
            <Text style={{ color: theme.hint, fontSize: 12, marginBottom: 10 }}>The recipient gives the courier this code when the parcel arrives. It goes to the recipient, not to you.</Text>
            <TouchableOpacity onPress={() => setParcel((p) => ({ ...p, acknowledged: !p.acknowledged }))} accessibilityRole="checkbox" accessibilityState={{ checked: parcel.acknowledged }} style={{ flexDirection: 'row', gap: 10, alignItems: 'center', marginBottom: 6 }}>
              <Ionicons name={parcel.acknowledged ? 'checkbox' : 'square-outline'} size={22} color={parcel.acknowledged ? theme.accent : theme.muted} />
              <Text style={{ color: theme.foreground, flex: 1, fontSize: 13 }}>This parcel contains no prohibited items{b.prohibited?.length ? ` (${b.prohibited.join('; ')})` : ''}.</Text>
            </TouchableOpacity>
            {showErrors && form.errors.acknowledged ? <Msg text={form.errors.acknowledged} theme={theme} /> : null}
          </>
        ) : null}

        <Text style={[ui.label, { color: theme.hint, marginTop: 8 }]}>YOUR NAME (OPTIONAL)</Text>
        <View style={[ui.box, { backgroundColor: theme.backgroundAlt, borderColor: theme.border }]}>
          <TextInput value={contactName} onChangeText={setContactName} placeholder="So the driver knows who to look for" placeholderTextColor={theme.hint} style={[ui.input, { color: theme.foreground }]} accessibilityLabel="Your name" maxLength={40} editable={!busy} />
        </View>
        <Text style={[ui.label, { color: theme.hint }]}>NOTE FOR THE {isParcel ? 'COURIER' : 'DRIVER'} (OPTIONAL)</Text>
        <View style={[ui.box, { backgroundColor: theme.backgroundAlt, borderColor: theme.border }]}>
          <TextInput value={notes} onChangeText={setNotes} placeholder="Gate colour, landmark…" placeholderTextColor={theme.hint} style={[ui.input, { color: theme.foreground }]} accessibilityLabel="Note" maxLength={300} editable={!busy} />
        </View>

        {left === 0 ? <TouchableOpacity onPress={() => navigation.navigate('TripPlanner')} accessibilityRole="button"><Text style={{ color: theme.accent, fontWeight: '800' }}>Get a fresh price</Text></TouchableOpacity> : null}
        <Msg text={error?.text} theme={theme} />
        {error && actionLabel ? <TouchableOpacity onPress={onAction} accessibilityRole="button" style={{ marginTop: 10 }}><Text style={{ color: theme.accent, fontWeight: '800' }}>{actionLabel}</Text></TouchableOpacity> : null}
        {error?.action === 'SUPPORT' ? <Text style={{ color: theme.muted, marginTop: 6 }}>Please contact Runserv support from the app’s Help section.</Text> : null}
      </ScrollView>
    </Screen>
  );
}
