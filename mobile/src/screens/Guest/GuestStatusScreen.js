// mobile/src/screens/Guest/GuestStatusScreen.js — booking status / tracking for the verified guest (M16 §3.4).
// Shows only what GET /guest/bookings/:id returns for the owner. Polls with back-off and stops at a final status.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Alert, Share, AppState } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { guestBookingAPI } from '../../services/api';
import { loadGuestSession, clearAttempt, clearLastBooking } from '../../services/guestSession';
import { parseApiError } from '../../utils/apiError';
import { statusLabel, isFinalStatus, pollDelayMs, showHandoverCode, failedFeeLine } from '../../utils/guestBooking';
import { spacedCode } from '../../utils/proofOfDelivery';
import { smsNotices, recipientCodeNotice } from '../../utils/guestNotices';
import { formatMoneyFor } from '../../utils/tripEstimate';
import { Screen, Cta, Msg, Row, ui } from './guestUi';

/** Distinct failure kinds (the guide asks for each to be handled differently). */
const kindOf = (e) => {
  const p = parseApiError(e);
  if (p.network) return 'NETWORK';
  if (p.status === 401 || p.code === 'GUEST_SESSION_EXPIRED' || p.code === 'GUEST_SESSION_REQUIRED') return 'SESSION';
  if (p.status === 404) return 'UNKNOWN';
  return 'OTHER';
};

export default function GuestStatusScreen({ navigation, route }) {
  const { theme } = useTheme();
  const { endGuestSession } = useAuth();
  const { bookingId, initial = null, justBooked = false } = route.params || {};
  const [data, setData] = useState(initial);
  const [fail, setFail] = useState(null);              // 'NETWORK' | 'SESSION' | 'UNKNOWN' | 'OTHER'
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [message, setMessage] = useState(null);
  const failures = useRef(0);
  const timer = useRef(null);
  const alive = useRef(true);
  const status = data?.status || data?.view?.status;

  const load = useCallback(async () => {
    clearTimeout(timer.current);
    let next = null;
    try {
      const s = await loadGuestSession();
      if (!s) { setFail('SESSION'); return; }
      const res = await guestBookingAPI.get(s.session, bookingId);
      if (!alive.current) return;
      failures.current = 0; setFail(null); setData(res?.data || null);
      next = pollDelayMs(res?.data?.status || res?.data?.view?.status, 0);
    } catch (e) {
      if (!alive.current) return;
      const k = kindOf(e); setFail(k);
      if (k === 'SESSION' || k === 'UNKNOWN') return;       // polling again cannot fix these
      failures.current += 1; next = pollDelayMs(status || 'FINDING_DRIVER', failures.current);
    }
    if (next && alive.current) timer.current = setTimeout(load, next);
  }, [bookingId, status]);

  useEffect(() => { alive.current = true; load(); return () => { alive.current = false; clearTimeout(timer.current); }; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const sub = AppState.addEventListener('change', (st) => { if (st === 'active' && !isFinalStatus(status)) load(); else if (st !== 'active') clearTimeout(timer.current); }); return () => sub.remove(); }, [load, status]);

  const withSession = async (fn) => {
    setBusy(true); setMessage(null);
    try { const s = await loadGuestSession(); if (!s) { setFail('SESSION'); return; } await fn(s.session); }
    catch (e) { const k = kindOf(e); if (k === 'SESSION') setFail('SESSION'); else setMessage(parseApiError(e).network ? 'No connection. Try again.' : (parseApiError(e).message || 'That did not work. Please try again.')); }
    finally { if (alive.current) setBusy(false); }
  };

  const cancel = () => Alert.alert('Cancel this booking?', 'You can book again any time.', [
    { text: 'Keep booking', style: 'cancel' },
    { text: 'Cancel booking', style: 'destructive', onPress: () => withSession(async (s) => { await guestBookingAPI.cancel(s, bookingId, 'Cancelled by guest'); await clearAttempt(); await load(); }) },
  ]);
  const share = () => data?.tracking?.url && !data.tracking.revoked && Share.share({ message: `Track my Runserv trip: ${data.tracking.url}` }).catch(() => {});
  const rotate = () => withSession(async (s) => { await guestBookingAPI.rotateTracking(s, bookingId); await load(); });
  const revoke = () => withSession(async (s) => { await guestBookingAPI.revokeTracking(s, bookingId); await load(); });
  const done = async () => { await clearLastBooking(); navigation.reset({ index: 0, routes: [{ name: 'TripPlanner' }] }); };
  // M16.1: only the credential is dropped; the booking reference stays, and verification returns to THIS booking.
  const reverify = async () => { await endGuestSession(); navigation.navigate('GuestVerify', { resumeBookingId: bookingId }); };

  const view = data?.view || {};
  const money = (n, c) => formatMoneyFor(n, c);
  const finalNow = isFinalStatus(status);
  const feeLine = failedFeeLine(view, money);
  const codeVisible = showHandoverCode(data, view);

  if (fail === 'SESSION' && !data) return (
    <Screen theme={theme} title="Your booking"><View style={{ padding: 20 }}>
      <Text style={{ color: theme.foreground, fontWeight: '800', fontSize: 16 }}>Your phone verification has ended</Text>
      <Text style={{ color: theme.muted, marginVertical: 10 }}>Verify again to see this booking. Your booking is not affected.</Text>
      <Cta theme={theme} label="Verify again" onPress={reverify} />
    </View></Screen>
  );
  if (fail === 'UNKNOWN' && !data) return (
    <Screen theme={theme} title="Your booking"><View style={{ padding: 20 }}>
      <Text style={{ color: theme.foreground, fontWeight: '800', fontSize: 16 }}>We could not find this booking</Text>
      <Text style={{ color: theme.muted, marginVertical: 10 }}>It may belong to a different phone number.</Text>
      <Cta theme={theme} label="Plan a trip" onPress={done} />
    </View></Screen>
  );

  return (
    <Screen theme={theme} title={data?.booking?.reference || 'Your booking'}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 28 }}>
        {justBooked ? <Text style={{ color: theme.accent, fontWeight: '800', marginBottom: 8 }}>Booked. We are finding {data?.booking?.service === 'PARCEL' ? 'a courier' : 'a driver'} now.</Text> : null}
        {fail === 'NETWORK' ? <Text accessibilityLiveRegion="polite" style={{ color: '#B45309', marginBottom: 8 }}>No connection. Showing the last update; retrying…</Text> : null}
        {fail === 'SESSION' ? <Text accessibilityLiveRegion="polite" style={{ color: '#B45309', marginBottom: 8 }}>Your verification has ended, so updates have stopped. Your booking is unaffected: verify again to see it.</Text> : null}

        <View style={[ui.card, { borderColor: theme.border, backgroundColor: theme.backgroundAlt }]}>
          <Text accessibilityLiveRegion="polite" style={{ color: theme.foreground, fontWeight: '900', fontSize: 20 }}>{statusLabel(status)}</Text>
          {view.cancellationReason && status === 'CANCELLED' ? <Text style={{ color: theme.muted, marginTop: 4 }}>{view.cancellationReason}</Text> : null}
          {view.earner ? <Text style={{ color: theme.muted, marginTop: 6 }}>{view.earner.firstName}{view.earner.vehicle?.plate ? ` · ${view.earner.vehicle.plate}` : ''}</Text> : null}
        </View>

        {(() => { const rn = recipientCodeNotice(data?.notices, data?.booking?.service); return (<>
          {rn.warning ? <Text accessibilityLiveRegion="polite" style={{ color: '#B45309', marginBottom: 8 }}>{rn.warning}</Text> : null}
          {rn.line && data?.podCodeVisible === false && !view.delivery?.proofVerified && !isFinalStatus(status) ? (
            <View style={[ui.card, { borderColor: theme.accent, backgroundColor: theme.accent + '12' }]}>
              <Text style={[ui.label, { color: theme.hint }]}>HAND-OVER CODE</Text>
              <Text accessibilityLiveRegion="polite" style={{ color: theme.foreground, fontSize: 13 }}>{rn.line}</Text>
              <Text style={{ color: theme.muted, fontSize: 12, marginTop: 4 }}>They give it to the courier on delivery. For their safety, you do not see the code.</Text>
            </View>
          ) : null}
        </>); })()}
        {smsNotices(data?.notices, data?.booking?.service).map((n) => <Text key={n.key} accessibilityLiveRegion="polite" style={{ color: '#B45309', marginBottom: 8 }}>{n.text}</Text>)}

        <View style={[ui.card, { borderColor: theme.border, backgroundColor: theme.backgroundAlt }]}>
          <Row theme={theme} label="Reference" value={data?.booking?.reference} />
          <Row theme={theme} label="Pickup" value={view.pickupAddress} />
          <Row theme={theme} label="Destination" value={view.dropoffAddress} />
          <Row theme={theme} label="Fare" value={data?.booking ? money(data.booking.fare, data.booking.currency) : ''} />
          {view.paymentNote ? <Text style={{ color: theme.hint, fontSize: 12, marginTop: 6 }}>{view.paymentNote}</Text> : null}
          {feeLine ? <Text style={{ color: '#B45309', fontSize: 12, marginTop: 6 }}>{feeLine}</Text> : null}
        </View>

        {codeVisible ? (
          <View style={[ui.card, { borderColor: theme.accent, backgroundColor: theme.accent + '12' }]}>
            <Text style={[ui.label, { color: theme.hint }]}>HAND-OVER CODE (FOR THE RECIPIENT)</Text>
            <Text style={{ color: theme.muted, fontSize: 12, marginBottom: 6 }}>The recipient also gets this. They give it to the courier on delivery. Do not share it with anyone else.</Text>
            <TouchableOpacity onPress={() => setReveal((v) => !v)} accessibilityRole="button" accessibilityLabel={reveal ? 'Hide code' : 'Show code'} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Text style={{ color: theme.foreground, fontSize: 28, fontWeight: '900', letterSpacing: 4 }}>{reveal ? spacedCode(data.podCode) : '••• •••'}</Text>
              <Ionicons name={reveal ? 'eye-off-outline' : 'eye-outline'} size={20} color={theme.muted} />
            </TouchableOpacity>
          </View>
        ) : null}

        {data?.tracking ? (
          <View style={[ui.card, { borderColor: theme.border, backgroundColor: theme.backgroundAlt }]}>
            <Text style={[ui.label, { color: theme.hint }]}>TRACKING LINK</Text>
            {data.tracking.revoked ? (
              <>
                <Text style={{ color: theme.muted }}>The link is turned off. Create a new one to share your trip again.</Text>
                <Cta theme={theme} tone="secondary" label="Create a new link" onPress={rotate} busy={busy} />
              </>
            ) : (
              <>
                <Text style={{ color: theme.muted, fontSize: 12, marginBottom: 8 }}>Anyone with the link can see this trip’s status and the vehicle. They cannot see your phone number.</Text>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <View style={{ flex: 1 }}><Cta theme={theme} tone="secondary" label="Share link" onPress={share} /></View>
                  <View style={{ flex: 1 }}><Cta theme={theme} tone="secondary" label="Turn off" onPress={revoke} busy={busy} /></View>
                </View>
              </>
            )}
          </View>
        ) : null}

        {view.cancellable && !finalNow ? <Cta theme={theme} tone="secondary" label="Cancel booking" onPress={cancel} busy={busy} /> : null}
        <Msg text={message} theme={theme} />

        {finalNow ? <View style={{ marginTop: 12 }}><Cta theme={theme} label="Plan another trip" onPress={done} /></View> : null}
        <TouchableOpacity onPress={() => navigation.navigate('GuestConvert', { bookingId })} accessibilityRole="button" style={{ marginTop: 18, alignItems: 'center' }}>
          <Text style={{ color: theme.accent, fontWeight: '800' }}>Create a free account to keep your trips</Text>
        </TouchableOpacity>
      </ScrollView>
    </Screen>
  );
}
