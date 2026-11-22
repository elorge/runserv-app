// mobile/src/screens/Auth/TripPlannerScreen.js
//
// Guest journey planner (guide §3.2): pickup + destination -> REAL route, distance and ETA -> vehicle options with server
// estimates -> continue to sign-in / registration. PREVIEW ONLY:
//   * distance, ETA and fares come from POST /guest/quote (provider route + server rate card); nothing is computed here;
//   * a quote is an estimate with an expiry, not a booking and not a guaranteed fare;
//   * no booking is created. Guest booking needs phone verification and is a separate, later stage.
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { View, Text, TextInput, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator, StatusBar } from 'react-native';
import Svg, { Polyline, Circle } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../context/ThemeContext';
import { guestAPI, rideAPI } from '../../services/api';
import { saveTripDraft, markPreviewSeen } from '../../services/tripDraft';
import { formatMoneyFor } from '../../utils/tripEstimate';
import {
  newSessionToken, needsDetails, toPlace, samePlace, routeToPath, formatKm, formatMinutes, secondsLeft, quoteErrorMessage,
} from '../../utils/guestPlanner';

const H_PAD = 20;
const MAP_H = 190;
const VEHICLE_LABEL = { CAR: 'Car', MOTORCYCLE: 'Bike', VAN: 'Van', TRICYCLE: 'Keke' };
const PARCEL_CATEGORIES = ['DOCUMENT', 'SMALL', 'MEDIUM', 'LARGE'];
const CAT_LABEL = { DOCUMENT: 'Document', SMALL: 'Small', MEDIUM: 'Medium', LARGE: 'Large' };

/** One address box with live suggestions. */
function PlaceField({ label, icon, place, onPick, onClear, countryCode, bias, theme, t }) {
  const [text, setText] = useState('');
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const token = useRef(newSessionToken());
  const timer = useRef(null);
  const seq = useRef(0);

  useEffect(() => () => clearTimeout(timer.current), []);

  const search = (v) => {
    setText(v);
    clearTimeout(timer.current);
    if (v.trim().length < 3) { setItems([]); return; }
    timer.current = setTimeout(async () => {
      const mine = ++seq.current;
      setBusy(true);
      try {
        const res = await guestAPI.autocomplete({ input: v.trim(), sessionToken: token.current, countryCode, ...(bias || {}) });
        if (mine === seq.current) setItems(res?.data?.suggestions || []);
      } catch { if (mine === seq.current) setItems([]); } finally { if (mine === seq.current) setBusy(false); }
    }, 350);
  };

  const choose = async (s) => {
    setBusy(true);
    try {
      let details = null;
      if (needsDetails(s)) details = (await guestAPI.placeDetails({ placeId: s.placeId, sessionToken: token.current }))?.data;
      const p = toPlace(s, details);
      if (p) { onPick(p); setItems([]); setText(''); token.current = newSessionToken(); }
    } catch { /* leave the list open so they can try another suggestion */ } finally { setBusy(false); }
  };

  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={[st.label, { color: theme.hint }]}>{label}</Text>
      {place ? (
        <View style={[st.box, { backgroundColor: theme.backgroundAlt, borderColor: theme.accent }]}>
          <Ionicons name={icon} size={18} color={theme.accent} />
          <Text numberOfLines={2} style={[st.boxTxt, { color: theme.foreground }]}>{place.label}</Text>
          <TouchableOpacity onPress={onClear} accessibilityRole="button" accessibilityLabel={t('tripPlanner.change', { defaultValue: 'Change' })} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="close-circle" size={20} color={theme.muted} />
          </TouchableOpacity>
        </View>
      ) : (
        <>
          <View style={[st.box, { backgroundColor: theme.backgroundAlt, borderColor: theme.border }]}>
            <Ionicons name={icon} size={18} color={theme.muted} />
            <TextInput value={text} onChangeText={search} placeholder={t('tripPlanner.search', { defaultValue: 'Search an address or place' })} placeholderTextColor={theme.hint}
              style={[st.input, { color: theme.foreground }]} autoCorrect={false} accessibilityLabel={label} maxLength={100} />
            {busy ? <ActivityIndicator size="small" color={theme.accent} /> : null}
          </View>
          {items.map((s) => (
            <TouchableOpacity key={s.placeId} onPress={() => choose(s)} style={[st.sugg, { borderColor: theme.border, backgroundColor: theme.backgroundAlt }]} accessibilityRole="button">
              <Text numberOfLines={1} style={[st.suggMain, { color: theme.foreground }]}>{s.mainText || s.description}</Text>
              {s.secondaryText ? <Text numberOfLines={1} style={[st.suggSub, { color: theme.muted }]}>{s.secondaryText}</Text> : null}
            </TouchableOpacity>
          ))}
        </>
      )}
    </View>
  );
}

export default function TripPlannerScreen({ navigation, route }) {
  const { theme } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  const [market, setMarket] = useState({ countryCode: 'NG', currency: 'NGN' });
  const [service, setService] = useState('RIDE');
  const [pickup, setPickup] = useState(null);
  const [dest, setDest] = useState(null);
  const [parcel, setParcel] = useState({ category: 'SMALL', weightKg: '2' });
  const [state, setState] = useState({ loading: false, error: null, data: null });
  const [vehicle, setVehicle] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [mapW, setMapW] = useState(300);
  const [bookingOn, setBookingOn] = useState(false);     // M16: GET /guest/config.bookingEnabled

  useEffect(() => { let a = true; guestAPI.config().then((r) => { if (a) setBookingOn(!!r?.data?.bookingEnabled); }).catch(() => {}); return () => { a = false; }; }, []);

  // A place chosen on the LocationPicker comes back as route.params.picked = { field, place, at }.
  const pickedAt = route?.params?.picked?.at;
  useEffect(() => {
    const pk = route?.params?.picked; if (!pk?.place) return;
    if (pk.field === 'pickup') setPickup(pk.place); else setDest(pk.place);
    setState({ loading: false, error: null, data: null }); setVehicle(null);
  }, [pickedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let alive = true;
    rideAPI.getPlatformRates().then((r) => { const p = r?.data; if (alive && p?.countryCode) setMarket({ countryCode: p.countryCode, currency: p.currency || 'NGN' }); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // countdown, only while a quote is on screen
  useEffect(() => {
    if (!state.data) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [state.data]);

  const money = useCallback((n) => formatMoneyFor(n, state.data?.options?.[0]?.quote?.currency || market.currency), [market.currency, state.data]);
  const same = samePlace(pickup, dest);
  const weightNum = Number(parcel.weightKg);
  const parcelOk = service !== 'PARCEL' || (Number.isFinite(weightNum) && weightNum > 0);
  const canQuote = !!pickup && !!dest && !same && parcelOk && !state.loading;

  const reset = () => { setState({ loading: false, error: null, data: null }); setVehicle(null); };

  const getQuote = async () => {
    setState({ loading: true, error: null, data: null }); setVehicle(null);
    try {
      const body = { service, countryCode: market.countryCode, pickup: { latitude: pickup.latitude, longitude: pickup.longitude }, destination: { latitude: dest.latitude, longitude: dest.longitude } };
      if (service === 'PARCEL') body.parcel = { category: parcel.category, weightKg: weightNum };
      const res = await guestAPI.quote(body);
      const data = res?.data;
      if (!data?.options) throw new Error('bad response');
      setState({ loading: false, error: null, data });
      setVehicle(data.options[0]?.vehicleType || null);
      setNow(Date.now());
    } catch (err) { setState({ loading: false, error: quoteErrorMessage(err), data: null }); }
  };

  const picked = state.data?.options?.find((o) => o.vehicleType === vehicle) || null;
  const left = picked ? secondsLeft(picked.quote.expiresAt, now) : 0;
  const path = useMemo(() => (state.data ? routeToPath(state.data.route.coords, mapW, MAP_H) : null), [state.data, mapW]);

  const openPicker = (field) => navigation.navigate('LocationPicker', { field, countryCode: market.countryCode, other: field === 'pickup' ? dest : pickup, initial: field === 'pickup' ? pickup : dest });

  const bookAsGuest = async () => {
    if (!picked) return;
    await markPreviewSeen();
    navigation.navigate('GuestVerify', { bundle: {
      service, countryCode: picked.quote.countryCode || market.countryCode, quote: picked.quote, vehicleType: vehicle, fare: picked.fare, currency: picked.quote.currency,
      pickup, destination: dest, distanceM: state.data.route.distanceM, durationS: state.data.route.durationS,
      parcel: service === 'PARCEL' ? { category: parcel.category, weightKg: weightNum } : undefined, prohibited: state.data.prohibited,
    } });
  };

  const proceed = async (screen) => {
    if (picked) {
      // Same draft the home screen reads for "Resume your trip": the estimate shown, never a booking.
      await saveTripDraft({
        distanceKm: Math.round((state.data.route.distanceM / 1000) * 10) / 10, vehicleType: vehicle, fare: picked.fare,
        minutes: Math.round(state.data.route.durationS / 60), currency: picked.quote.currency, countryCode: picked.quote.countryCode,
        step: 1, source: 'planner', pickupLabel: pickup.label, destinationLabel: dest.label, service,
      });
    }
    await markPreviewSeen();
    navigation.navigate(screen);
  };

  return (
    <View style={[st.root, { backgroundColor: theme.background }]}>
      <StatusBar barStyle="default" backgroundColor="transparent" translucent />
      <View style={[st.top, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} accessibilityRole="button" accessibilityLabel={t('tripPlanner.back', { defaultValue: 'Back' })} style={[st.backBtn, { borderColor: theme.border, backgroundColor: theme.backgroundAlt }]}>
          <Ionicons name="chevron-back" size={18} color={theme.foreground} />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => proceed('Login')}><Text style={[st.signIn, { color: theme.accent }]}>{t('onboarding.signIn', { defaultValue: 'Sign In' })}</Text></TouchableOpacity>
      </View>

      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: H_PAD, paddingBottom: insets.bottom + 32 }}>
        <Text accessibilityRole="header" style={[st.title, { color: theme.foreground }]}>{t('tripPlanner.title', { defaultValue: 'Plan your trip' })}</Text>
        <Text style={[st.sub, { color: theme.muted }]}>{t('tripPlanner.sub', { defaultValue: 'See the real route and an estimate. No account needed to look.' })}</Text>

        <View style={st.seg}>
          {[['RIDE', 'Book a ride', 'car-outline'], ['PARCEL', 'Send a parcel', 'cube-outline']].map(([k, l, ic]) => (
            <TouchableOpacity key={k} onPress={() => { setService(k); reset(); }} accessibilityRole="button" accessibilityState={{ selected: service === k }}
              style={[st.segBtn, { borderColor: service === k ? theme.accent : theme.border, backgroundColor: service === k ? theme.accent + '1A' : theme.backgroundAlt }]}>
              <Ionicons name={ic} size={16} color={service === k ? theme.accent : theme.muted} />
              <Text style={[st.segTxt, { color: service === k ? theme.accent : theme.foreground }]}>{l}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <PlaceField label={service === 'PARCEL' ? 'PICKUP (SENDER)' : 'PICKUP'} icon="radio-button-on" place={pickup} onPick={(p) => { setPickup(p); reset(); }} onClear={() => { setPickup(null); reset(); }} countryCode={market.countryCode} theme={theme} t={t} />
        <PlaceField label={service === 'PARCEL' ? 'DROP-OFF (RECIPIENT)' : 'DESTINATION'} icon="location" place={dest} onPick={(p) => { setDest(p); reset(); }} onClear={() => { setDest(null); reset(); }} countryCode={market.countryCode}
          bias={pickup ? { lat: pickup.latitude, lng: pickup.longitude } : null} theme={theme} t={t} />
        <View style={{ flexDirection: 'row', gap: 16, marginBottom: 8 }}>
          <TouchableOpacity onPress={() => openPicker('pickup')} accessibilityRole="button"><Text style={{ color: theme.accent, fontWeight: '700', fontSize: 13 }}>Pickup: map or my location</Text></TouchableOpacity>
          <TouchableOpacity onPress={() => openPicker('destination')} accessibilityRole="button"><Text style={{ color: theme.accent, fontWeight: '700', fontSize: 13 }}>Destination: map</Text></TouchableOpacity>
        </View>
        {same ? <Text style={[st.warn, { color: '#DC2626' }]}>{t('tripPlanner.same', { defaultValue: 'Pickup and destination are the same place.' })}</Text> : null}

        {service === 'PARCEL' && (
          <View style={{ marginBottom: 12 }}>
            <Text style={[st.label, { color: theme.hint }]}>PARCEL</Text>
            <View style={st.chips}>
              {PARCEL_CATEGORIES.map((c) => (
                <TouchableOpacity key={c} onPress={() => { setParcel((p) => ({ ...p, category: c })); reset(); }} accessibilityRole="button" accessibilityState={{ selected: parcel.category === c }}
                  style={[st.chip, { borderColor: parcel.category === c ? theme.accent : theme.border, backgroundColor: parcel.category === c ? theme.accent + '1A' : theme.backgroundAlt }]}>
                  <Text style={{ color: parcel.category === c ? theme.accent : theme.foreground, fontWeight: '700', fontSize: 13 }}>{CAT_LABEL[c]}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={[st.box, { backgroundColor: theme.backgroundAlt, borderColor: parcelOk ? theme.border : '#DC2626', marginTop: 8 }]}>
              <Ionicons name="barbell-outline" size={18} color={theme.muted} />
              <TextInput value={parcel.weightKg} onChangeText={(v) => { setParcel((p) => ({ ...p, weightKg: v.replace(/[^0-9.]/g, '') })); reset(); }} keyboardType="decimal-pad"
                placeholder="Weight in kg" placeholderTextColor={theme.hint} style={[st.input, { color: theme.foreground }]} accessibilityLabel="Parcel weight in kilograms" maxLength={6} />
              <Text style={{ color: theme.muted }}>kg</Text>
            </View>
          </View>
        )}

        <TouchableOpacity disabled={!canQuote} onPress={getQuote} accessibilityRole="button" style={[st.cta, { backgroundColor: theme.accent, opacity: canQuote ? 1 : 0.45 }]}>
          {state.loading ? <ActivityIndicator color="#fff" /> : <Text style={st.ctaTxt}>{t('tripPlanner.get', { defaultValue: 'Get route & estimate' })}</Text>}
        </TouchableOpacity>
        {state.error ? <Text accessibilityLiveRegion="polite" style={[st.warn, { color: '#DC2626', marginTop: 10 }]}>{state.error}</Text> : null}

        {state.data && (
          <View style={{ marginTop: 18 }}>
            <View onLayout={(e) => setMapW(Math.max(120, e.nativeEvent.layout.width))} style={[st.map, { backgroundColor: theme.backgroundAlt, borderColor: theme.border }]} accessible accessibilityLabel={`Route ${formatKm(state.data.route.distanceM)}, about ${formatMinutes(state.data.route.durationS)}`}>
              {path ? (
                <Svg width={mapW} height={MAP_H}>
                  <Polyline points={path.points} fill="none" stroke={theme.accent} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" />
                  <Circle cx={path.start.x} cy={path.start.y} r={6} fill="#fff" stroke={theme.accent} strokeWidth={3} />
                  <Circle cx={path.end.x} cy={path.end.y} r={6} fill={theme.accent} />
                </Svg>
              ) : null}
            </View>
            <View style={st.stats}>
              <Text style={[st.stat, { color: theme.foreground }]}>{formatKm(state.data.route.distanceM)}</Text>
              <Text style={[st.stat, { color: theme.foreground }]}>≈ {formatMinutes(state.data.route.durationS)}</Text>
            </View>

            {state.data.options.length === 0 && <Text style={[st.warn, { color: '#DC2626' }]}>{t('tripPlanner.none', { defaultValue: 'No vehicle can take this right now. See the notes below.' })}</Text>}
            {state.data.options.map((o) => (
              <TouchableOpacity key={o.vehicleType} onPress={() => setVehicle(o.vehicleType)} accessibilityRole="button" accessibilityState={{ selected: vehicle === o.vehicleType }}
                style={[st.opt, { borderColor: vehicle === o.vehicleType ? theme.accent : theme.border, backgroundColor: theme.backgroundAlt }]}>
                <Text style={[st.optName, { color: theme.foreground }]}>{VEHICLE_LABEL[o.vehicleType] || o.vehicleType}</Text>
                <Text style={[st.optFare, { color: theme.foreground }]}>{money(o.fare)}</Text>
              </TouchableOpacity>
            ))}
            {state.data.unavailable?.map((u) => (
              <Text key={u.vehicleType} style={[st.fine, { color: theme.muted }]}>{VEHICLE_LABEL[u.vehicleType] || u.vehicleType}: {u.message}</Text>
            ))}
            {state.data.prohibited ? <Text style={[st.fine, { color: theme.muted }]}>Not carried: {state.data.prohibited.join('; ')}.</Text> : null}

            <Text style={[st.fine, { color: theme.hint }]}>{state.data.note}</Text>
            {picked ? (
              <Text accessibilityLiveRegion="polite" style={[st.fine, { color: left > 0 ? theme.hint : '#DC2626' }]}>
                {left > 0 ? `Estimate valid for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'This estimate has expired. Tap “Get route & estimate” for a fresh one.'}
              </Text>
            ) : null}

            {bookingOn ? (
              <TouchableOpacity disabled={!picked || left <= 0} onPress={bookAsGuest} accessibilityRole="button" style={[st.cta, { backgroundColor: theme.accent, marginTop: 14, opacity: picked && left > 0 ? 1 : 0.45 }]}>
                <Text style={st.ctaTxt}>Book without an account</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity disabled={!picked || left <= 0} onPress={() => proceed('Register')} accessibilityRole="button" style={[st.cta, { backgroundColor: theme.accent, marginTop: 14, opacity: picked && left > 0 ? 1 : 0.45 }]}>
              <Text style={st.ctaTxt}>{t('tripPlanner.continue', { defaultValue: 'Create account to book' })}</Text>
            </TouchableOpacity>
            <Text style={[st.fine, { color: theme.hint, textAlign: 'center' }]}>{t('tripPlanner.noBooking', { defaultValue: 'Nothing is booked yet. You confirm after signing in.' })}</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1 },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: H_PAD, paddingBottom: 6 },
  backBtn: { width: 32, height: 32, borderRadius: 16, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  signIn: { fontSize: 14, fontWeight: '700' },
  title: { fontSize: 28, fontWeight: '800', letterSpacing: -0.5, marginTop: 8 },
  sub: { fontSize: 14, lineHeight: 20, marginTop: 6, marginBottom: 16 },
  seg: { flexDirection: 'row', gap: 10, marginBottom: 16 },
  segBtn: { flex: 1, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderRadius: 14, paddingVertical: 11 },
  segTxt: { fontSize: 13, fontWeight: '800' },
  label: { fontSize: 10, fontWeight: '800', letterSpacing: 2.5, marginBottom: 6 },
  box: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1.5, borderRadius: 14, paddingHorizontal: 12, minHeight: 48 },
  boxTxt: { flex: 1, fontSize: 14, fontWeight: '600', paddingVertical: 10 },
  input: { flex: 1, fontSize: 15, paddingVertical: 12 },
  sugg: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, marginTop: 6 },
  suggMain: { fontSize: 14, fontWeight: '700' },
  suggSub: { fontSize: 12, marginTop: 2 },
  chips: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: { borderWidth: 1.5, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 9 },
  cta: { borderRadius: 16, paddingVertical: 15, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  ctaTxt: { color: '#FFFFFF', fontSize: 16, fontWeight: '800' },
  warn: { fontSize: 13, fontWeight: '600', marginBottom: 6 },
  map: { height: MAP_H, borderWidth: 1, borderRadius: 18, overflow: 'hidden' },
  stats: { flexDirection: 'row', gap: 18, marginVertical: 10 },
  stat: { fontSize: 17, fontWeight: '800' },
  opt: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderWidth: 1.5, borderRadius: 14, padding: 14, marginBottom: 8 },
  optName: { fontSize: 16, fontWeight: '800' },
  optFare: { fontSize: 17, fontWeight: '800' },
  fine: { fontSize: 11.5, lineHeight: 16, marginTop: 6 },
});
