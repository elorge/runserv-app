// mobile/src/screens/Auth/TripPreviewScreen.js
//
// "Boarding Pass" — the customer app's front door.
//
// Instead of a wall of sign-up fields, a new visitor PLAYS with the product first:
//   1. Plan   – drag how far they're going and watch the route stretch.
//   2. Ride   – compare Keke / Okada / Car / Van with live prices from the real Runserv rate card.
//   3. Pass   – get a boarding pass for that trip. Creating an account "activates" it.
// Their choices are saved on the device the whole way, so sign-up (or closing the app) never loses
// them: HomeScreen offers "Resume your trip" as soon as they're in.
//
// Needs no account, no GPS permission and no map tiles. Fares come from the PUBLIC
// GET /rides/platform-rates and are labelled as estimates.
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Animated, Dimensions, StatusBar,
  ScrollView, PanResponder, Image, Platform, Easing,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../context/ThemeContext';
import { BRAND } from '../../theme/theme';
import { rideAPI, guestAPI } from '../../services/api';
import PoweredBy from '../../components/PoweredBy';
import TripPreviewMap, { MIN_KM, MAX_KM } from '../../components/TripPreviewMap';
import { getCountryCenter } from '../../utils/countryGeo';
import { resolveVehicleIconKey, vehicleIconSource } from '../../utils/vehicleIcons';
import { PREVIEW_VEHICLES, FALLBACK_RATES, estimateTrip, formatMoneyFor, tripMinutes } from '../../utils/tripEstimate';
import { loadTripDraft, saveTripDraft, newPassCode, markPreviewSeen } from '../../services/tripDraft';

const { width: W, height: H } = Dimensions.get('window');
const H_PAD = 20;
const MAP_W = W - H_PAD * 2;
const MAP_H = Math.round(Math.min(300, Math.max(190, H * 0.30)));
const LOGO_DARK  = require('../../../assets/runserv_light.png'); // white mark → dark backgrounds
const LOGO_LIGHT = require('../../../assets/runserv_dark.png');  // dark mark  → light backgrounds

const STEPS = ['plan', 'ride', 'pass'];

// Pseudo-barcode for the pass: deterministic from the code so the same trip always looks the same.
const barsFor = (code) => {
  let seed = 7;
  for (let i = 0; i < code.length; i += 1) seed = (seed * 31 + code.charCodeAt(i)) % 9973;
  const out = [];
  for (let i = 0; i < 34; i += 1) { seed = (seed * 133 + 71) % 9973; out.push(1 + (seed % 4)); }
  return out;
};

export default function TripPreviewScreen({ navigation }) {
  const { theme, mode } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  const [step, setStep]       = useState(0);
  const [km, setKm]           = useState(7);
  const [vehicle, setVehicle] = useState('CAR');
  const [passCode, setPassCode] = useState(() => newPassCode());
  const [market, setMarket]   = useState({ rates: FALLBACK_RATES, currency: 'NGN', countryCode: 'NG', roundingStep: 50, live: false });
  const [restored, setRestored] = useState(false);
  const [planner, setPlanner] = useState(false); // server flag GUEST_PLANNING_ENABLED: real addresses + route

  const enter = useRef(new Animated.Value(1)).current;
  // Only keep a draft once the visitor has really engaged (reached "rides" or came back to an old draft),
  // so tapping "Sign In" straight away never leaves a phantom trip behind.
  const engaged = useRef(false);
  if (step >= 1) engaged.current = true;

  // ── restore the last interaction, then fetch the live rate card ─────────────
  useEffect(() => {
    let alive = true;
    (async () => {
      const d = await loadTripDraft();
      if (alive && d) {
        engaged.current = true;
        setKm(Math.min(MAX_KM, Math.max(MIN_KM, Math.round(d.distanceKm))));
        if (PREVIEW_VEHICLES.includes(d.vehicleType)) setVehicle(d.vehicleType);
        if (d.passCode) setPassCode(d.passCode);
        if (Number.isInteger(d.step)) setStep(Math.min(2, Math.max(0, d.step)));
      }
      if (alive) setRestored(true);
    })();
    (async () => {
      try {
        const res = await rideAPI.getPlatformRates();
        const p = res?.data;
        if (alive && p?.rates) {
          setMarket({
            rates: { ...FALLBACK_RATES, ...p.rates },
            currency: p.currency || 'NGN',
            countryCode: p.countryCode || 'NG',
            roundingStep: p.roundingStep || 50,
            live: true,
          });
        }
      } catch { /* offline: the built-in rate card still gives a sensible estimate */ }
    })();
    guestAPI.config().then((r) => { if (alive && r?.data?.planningEnabled) setPlanner(true); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const city = getCountryCenter(market.countryCode).city;
  const money = useCallback((n) => formatMoneyFor(n, market.currency), [market.currency]);
  const quote = useMemo(() => estimateTrip(km, vehicle, market.rates, market.roundingStep), [km, vehicle, market]);
  const quotes = useMemo(() => PREVIEW_VEHICLES.map((v) => ({ v, ...estimateTrip(km, v, market.rates, market.roundingStep) })), [km, market]);
  const cheapest = useMemo(() => quotes.reduce((a, b) => (b.fare < a.fare ? b : a)).v, [quotes]);

  // ── persist every change, so the trip is never lost ─────────────────────────
  useEffect(() => {
    if (!restored || !engaged.current) return;
    saveTripDraft({ distanceKm: km, vehicleType: vehicle, fare: quote.fare, minutes: quote.minutes, currency: market.currency, countryCode: market.countryCode, passCode, step });
  }, [restored, km, vehicle, step, quote.fare, quote.minutes, market.currency, market.countryCode, passCode]);

  const go = (next) => {
    enter.setValue(0);
    setStep(next);
    Animated.timing(enter, { toValue: 1, duration: 380, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  };

  const leaveTo = async (screen) => { await markPreviewSeen(); navigation.navigate(screen); };

  // ── distance slider (drag anywhere on the strip) ────────────────────────────
  const trackW = useRef(1);
  const startKm = useRef(km);
  const kmRef = useRef(km);
  kmRef.current = km;
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => { startKm.current = kmRef.current; },
    onPanResponderMove: (_, g) => {
      const next = startKm.current + (g.dx / trackW.current) * (MAX_KM - MIN_KM);
      setKm(Math.min(MAX_KM, Math.max(MIN_KM, Math.round(next))));
    },
  })).current;

  const thumbLeft = ((km - MIN_KM) / (MAX_KM - MIN_KM)) * 100;
  const presets = [
    { km: 2,  title: t('tripPreview.hop',    { defaultValue: 'Quick hop' }) },
    { km: 7,  title: t('tripPreview.across', { defaultValue: 'Across {{city}}', city }) },
    { km: 15, title: t('tripPreview.cross',  { defaultValue: 'Cross-city' }) },
  ];

  const vehicleName = (v) => {
    const ng = market.countryCode === 'NG';
    if (v === 'TRICYCLE')   return ng ? 'Keke' : t('tripPreview.vTricycle', { defaultValue: 'Tricycle' });
    if (v === 'MOTORCYCLE') return ng ? 'Okada' : t('tripPreview.vMoto', { defaultValue: 'Motorbike' });
    if (v === 'VAN')        return t('tripPreview.vVan', { defaultValue: 'Van' });
    return t('tripPreview.vCar', { defaultValue: 'Car' });
  };
  const vehicleSub = (v) => ({
    TRICYCLE:   t('tripPreview.subTricycle', { defaultValue: 'Budget-friendly · up to 3' }),
    MOTORCYCLE: t('tripPreview.subMoto',     { defaultValue: 'Beat the traffic · 1 rider' }),
    CAR:        t('tripPreview.subCar',      { defaultValue: 'Comfortable · up to 4' }),
    VAN:        t('tripPreview.subVan',      { defaultValue: 'Groups & luggage' }),
  }[v]);

  const heading = [
    { k: t('tripPreview.step1Eyebrow', { defaultValue: 'PLAN YOUR TRIP' }),  h: t('tripPreview.step1Title', { defaultValue: 'Where to today?' }),            sub: t('tripPreview.step1Sub', { defaultValue: 'Slide to set the distance. No account needed, just see what it would cost.' }) },
    { k: t('tripPreview.step2Eyebrow', { defaultValue: 'CHOOSE YOUR RIDE' }), h: t('tripPreview.step2Title', { defaultValue: 'How do you want to go?' }), sub: t('tripPreview.step2Sub', { defaultValue: 'Prices come straight from the Runserv rate card.' }) },
    { k: t('tripPreview.step3Eyebrow', { defaultValue: 'YOUR BOARDING PASS' }), h: t('tripPreview.step3Title', { defaultValue: 'Your trip is ready.' }),    sub: t('tripPreview.step3Sub', { defaultValue: 'Create your account to activate it. We have saved everything.' }) },
  ][step];

  const logo = mode === 'dark' ? LOGO_DARK : LOGO_LIGHT;
  const fade = { opacity: enter, transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }] };

  return (
    <View style={[s.root, { backgroundColor: theme.background }]}>
      <StatusBar barStyle={mode === 'dark' ? 'light-content' : 'dark-content'} backgroundColor="transparent" translucent />
      <View style={[s.glow, { backgroundColor: theme.accent }]} />

      {/* top bar */}
      <View style={[s.topBar, { paddingTop: insets.top + 8 }]}>
        <View style={s.brand}>
          {step > 0 ? (
            <TouchableOpacity onPress={() => go(step - 1)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} style={[s.backBtn, { borderColor: theme.border, backgroundColor: theme.backgroundAlt }]}>
              <Ionicons name="chevron-back" size={18} color={theme.foreground} />
            </TouchableOpacity>
          ) : (
            <Image source={logo} style={s.logo} resizeMode="contain" />
          )}
          <View style={s.dots}>
            {STEPS.map((k, i) => (
              <View key={k} style={[s.dot, { backgroundColor: i <= step ? theme.accent : theme.border, width: i === step ? 22 : 7 }]} />
            ))}
          </View>
        </View>
        <TouchableOpacity onPress={() => leaveTo('Login')} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={[s.signIn, { color: theme.accent }]}>{t('onboarding.signIn', { defaultValue: 'Sign In' })}</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 28 }} showsVerticalScrollIndicator={false} bounces={false}>
        <Animated.View style={[s.head, fade]}>
          <Text style={[s.eyebrow, { color: theme.accent }]}>{heading.k}</Text>
          <Text style={[s.title, { color: theme.foreground }]}>{heading.h}</Text>
          <Text style={[s.sub, { color: theme.muted }]}>{heading.sub}</Text>
        </Animated.View>

        {/* the living map: always on screen, reacts to every choice */}
        <View style={{ paddingHorizontal: H_PAD }}>
          <TripPreviewMap width={MAP_W} height={MAP_H} km={km} vehicleType={vehicle} theme={theme} mode={mode} label={`${km} km`} />
        </View>

        {/* ───────────── STEP 1 · PLAN ───────────── */}
        {step === 0 && (
          <Animated.View style={[s.panel, fade]}>
            <View style={s.chipRow}>
              {presets.map((p) => {
                const on = km === p.km;
                return (
                  <TouchableOpacity key={p.km} activeOpacity={0.85} onPress={() => setKm(p.km)}
                    style={[s.chip, { borderColor: on ? theme.accent : theme.border, backgroundColor: on ? theme.accent + '1F' : theme.backgroundAlt }]}>
                    <Text style={[s.chipTitle, { color: on ? theme.accent : theme.foreground }]} numberOfLines={1}>{p.title}</Text>
                    <Text style={[s.chipKm, { color: theme.hint }]}>~{p.km} km</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={[s.sliderCard, { backgroundColor: theme.backgroundAlt, borderColor: theme.border }]}>
              <View style={s.sliderHead}>
                <Text style={[s.sliderLabel, { color: theme.hint }]}>{t('tripPreview.distance', { defaultValue: 'DISTANCE' })}</Text>
                <Text style={[s.sliderVal, { color: theme.foreground }]}>{km} km <Text style={{ color: theme.hint, fontWeight: '500' }}>· ~{tripMinutes(km)} min</Text></Text>
              </View>
              <View style={s.sliderHit} {...pan.panHandlers} onLayout={(e) => { trackW.current = Math.max(1, e.nativeEvent.layout.width); }}>
                <View style={[s.track, { backgroundColor: theme.border }]}>
                  <View style={[s.trackFill, { width: `${thumbLeft}%`, backgroundColor: theme.accent }]} />
                </View>
                <View pointerEvents="none" style={[s.thumb, { left: `${thumbLeft}%`, backgroundColor: '#FFFFFF', borderColor: theme.accent, shadowColor: theme.accent }]} />
              </View>
              <View style={s.sliderEnds}>
                <Text style={[s.endTxt, { color: theme.hint }]}>{MIN_KM} km</Text>
                <Text style={[s.endTxt, { color: theme.hint }]}>{MAX_KM} km</Text>
              </View>
            </View>

            <TouchableOpacity activeOpacity={0.88} onPress={() => go(1)} style={[s.cta, { backgroundColor: theme.accent, shadowColor: theme.accent }]}>
              <Text style={s.ctaTxt}>{t('tripPreview.seeRides', { defaultValue: 'See rides & prices' })}</Text>
              <Ionicons name="arrow-forward" size={18} color="#FFFFFF" />
            </TouchableOpacity>
            {planner ? (
              <TouchableOpacity onPress={() => navigation.navigate('TripPlanner')} accessibilityRole="button" style={s.ghost}>
                <Text style={[s.ghostTxt, { color: theme.accent, fontWeight: '700' }]}>{t('tripPlanner.entry', { defaultValue: 'Plan with real addresses and route' })}</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity onPress={() => leaveTo('Register')} style={s.ghost}>
              <Text style={[s.ghostTxt, { color: theme.hint }]}>{t('tripPreview.skip', { defaultValue: 'Skip, create my account' })}</Text>
            </TouchableOpacity>
          </Animated.View>
        )}

        {/* ───────────── STEP 2 · RIDE ───────────── */}
        {step === 1 && (
          <Animated.View style={[s.panel, fade]}>
            {quotes.map((q) => {
              const on = q.v === vehicle;
              const key = resolveVehicleIconKey(q.v, { colour: 'blue' });
              return (
                <TouchableOpacity key={q.v} activeOpacity={0.88} onPress={() => setVehicle(q.v)}
                  style={[s.ride, { borderColor: on ? theme.accent : theme.border, backgroundColor: on ? theme.accent + '14' : theme.backgroundAlt }]}>
                  <View style={[s.rideIcon, { backgroundColor: on ? theme.accent + '22' : theme.pill }]}>
                    <Image source={vehicleIconSource(key)} style={s.rideImg} resizeMode="contain" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={s.rideNameRow}>
                      <Text style={[s.rideName, { color: theme.foreground }]}>{vehicleName(q.v)}</Text>
                      {q.v === cheapest && (
                        <View style={[s.tag, { backgroundColor: BRAND.keke + '26' }]}><Text style={[s.tagTxt, { color: mode === 'dark' ? BRAND.keke : '#8A6200' }]}>{t('tripPreview.cheapest', { defaultValue: 'CHEAPEST' })}</Text></View>
                      )}
                    </View>
                    <Text style={[s.rideSub, { color: theme.hint }]} numberOfLines={1}>{vehicleSub(q.v)}</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={[s.ridePrice, { color: on ? theme.accent : theme.foreground }]}>{money(q.fare)}</Text>
                    <Text style={[s.rideSub, { color: theme.hint }]}>~{q.minutes} min</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
            <Text style={[s.fine, { color: theme.hint }]}>
              {market.live
                ? t('tripPreview.fineLive', { defaultValue: 'Estimate for a typical trip. Your final fare is confirmed when you book.' })
                : t('tripPreview.fineOffline', { defaultValue: 'Offline estimate. Your final fare is confirmed when you book.' })}
            </Text>
            <TouchableOpacity activeOpacity={0.88} onPress={() => go(2)} style={[s.cta, { backgroundColor: theme.accent, shadowColor: theme.accent }]}>
              <Text style={s.ctaTxt}>{t('tripPreview.getPass', { defaultValue: 'Get my boarding pass' })}</Text>
              <Ionicons name="ticket-outline" size={18} color="#FFFFFF" />
            </TouchableOpacity>
          </Animated.View>
        )}

        {/* ───────────── STEP 3 · PASS ───────────── */}
        {step === 2 && (
          <Animated.View style={[s.panel, fade]}>
            <View style={[s.ticket, { backgroundColor: theme.backgroundAlt, borderColor: theme.border, shadowColor: theme.accent }]}>
              <LinearGradient colors={[BRAND.navy, '#0A4F8F', BRAND.blue]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.ticketHead}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Ionicons name="navigate-circle" size={18} color={BRAND.cyan} />
                  <Text style={s.ticketBrand}>RUNSERV · BOARDING PASS</Text>
                </View>
                <Text style={s.ticketCode}>{passCode}</Text>
              </LinearGradient>

              <View style={s.ticketBody}>
                <View style={s.routeRow}>
                  <View style={s.routeCol}>
                    <Text style={[s.small, { color: theme.hint }]}>{t('tripPreview.from', { defaultValue: 'FROM' })}</Text>
                    <Text style={[s.place, { color: theme.foreground }]}>{t('tripPreview.yourLocation', { defaultValue: 'Your location' })}</Text>
                  </View>
                  <View style={s.routeMid}>
                    <View style={[s.routeDot, { borderColor: theme.accent }]} />
                    <View style={[s.routeDash, { borderColor: theme.accent }]} />
                    <Ionicons name="location" size={16} color={theme.accent} />
                  </View>
                  <View style={[s.routeCol, { alignItems: 'flex-end' }]}>
                    <Text style={[s.small, { color: theme.hint }]}>{t('tripPreview.to', { defaultValue: 'TO' })}</Text>
                    <Text style={[s.place, { color: theme.foreground }]}>{t('tripPreview.yourStop', { defaultValue: 'You choose' })}</Text>
                  </View>
                </View>

                <View style={s.statRow}>
                  {[
                    [t('tripPreview.ride', { defaultValue: 'RIDE' }), vehicleName(vehicle)],
                    [t('tripPreview.dist', { defaultValue: 'DISTANCE' }), `${km} km`],
                    [t('tripPreview.time', { defaultValue: 'TIME' }), `~${quote.minutes} min`],
                  ].map(([k, v]) => (
                    <View key={k} style={{ flex: 1 }}>
                      <Text style={[s.small, { color: theme.hint }]}>{k}</Text>
                      <Text style={[s.stat, { color: theme.foreground }]} numberOfLines={1}>{v}</Text>
                    </View>
                  ))}
                </View>
              </View>

              {/* perforation */}
              <View style={s.perf}>
                <View style={[s.notch, { left: -12, backgroundColor: theme.background, borderColor: theme.border }]} />
                <View style={[s.perfLine, { borderColor: theme.border }]} />
                <View style={[s.notch, { right: -12, backgroundColor: theme.background, borderColor: theme.border }]} />
              </View>

              <View style={s.ticketFoot}>
                <View style={{ flex: 1 }}>
                  <Text style={[s.small, { color: theme.hint }]}>{t('tripPreview.estFare', { defaultValue: 'ESTIMATED FARE' })}</Text>
                  <Text style={[s.fare, { color: theme.foreground }]}>{money(quote.fare)}</Text>
                  <View style={[s.status, { backgroundColor: BRAND.keke + '22' }]}>
                    <Ionicons name="lock-closed" size={11} color={mode === 'dark' ? BRAND.keke : '#8A6200'} />
                    <Text style={[s.statusTxt, { color: mode === 'dark' ? BRAND.keke : '#8A6200' }]}>{t('tripPreview.notActivated', { defaultValue: 'Not activated yet' })}</Text>
                  </View>
                </View>
                <View style={s.bars}>
                  {barsFor(passCode).map((w, i) => (
                    <View key={i} style={{ width: w, height: i % 5 === 0 ? 46 : 38, marginRight: 1.5, backgroundColor: theme.foreground, opacity: 0.85 }} />
                  ))}
                </View>
              </View>
            </View>

            <TouchableOpacity activeOpacity={0.88} onPress={() => leaveTo('Register')} style={[s.cta, { backgroundColor: theme.accent, shadowColor: theme.accent }]}>
              <Text style={s.ctaTxt}>{t('tripPreview.activate', { defaultValue: 'Activate & create account' })}</Text>
              <Ionicons name="arrow-forward" size={18} color="#FFFFFF" />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => leaveTo('Login')} style={s.ghost}>
              <Text style={[s.ghostTxt, { color: theme.hint }]}>
                {t('onboarding.haveAccount', { defaultValue: 'Have an account?' })}{' '}
                <Text style={{ color: theme.accent, fontWeight: '700' }}>{t('onboarding.signIn', { defaultValue: 'Sign In' })}</Text>
              </Text>
            </TouchableOpacity>
            <PoweredBy />
          </Animated.View>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  glow: { position: 'absolute', width: W * 1.3, height: W * 1.3, borderRadius: W * 0.65, top: -W * 0.85, alignSelf: 'center', opacity: 0.08 },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: H_PAD, paddingBottom: 6 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  logo: { width: 40, height: 28 },
  backBtn: { width: 32, height: 32, borderRadius: 16, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  dots: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  dot: { height: 7, borderRadius: 3.5 },
  signIn: { fontSize: 14, fontWeight: '700' },

  head: { paddingHorizontal: H_PAD + 4, paddingTop: 8, paddingBottom: 14 },
  eyebrow: { fontSize: 11, fontWeight: '800', letterSpacing: 3 },
  title: { fontSize: 30, fontWeight: '800', letterSpacing: -0.5, marginTop: 6 },
  sub: { fontSize: 14, lineHeight: 20, marginTop: 6 },

  panel: { paddingHorizontal: H_PAD, paddingTop: 16 },
  chipRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  chip: { flex: 1, borderWidth: 1.5, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 10 },
  chipTitle: { fontSize: 13, fontWeight: '700' },
  chipKm: { fontSize: 11, marginTop: 2, fontWeight: '500' },

  sliderCard: { borderWidth: 1, borderRadius: 18, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10 },
  sliderHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  sliderLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 2.5 },
  sliderVal: { fontSize: 20, fontWeight: '800' },
  sliderHit: { height: 48, justifyContent: 'center' },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  trackFill: { height: 6, borderRadius: 3 },
  thumb: { position: 'absolute', width: 26, height: 26, borderRadius: 13, borderWidth: 3, marginLeft: -13, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.4, shadowRadius: 6, elevation: 5 },
  sliderEnds: { flexDirection: 'row', justifyContent: 'space-between' },
  endTxt: { fontSize: 11, fontWeight: '500' },

  cta: { marginTop: 18, height: 54, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.35, shadowRadius: 18, elevation: 10 },
  ctaTxt: { color: '#FFFFFF', fontSize: 16, fontWeight: '700', letterSpacing: 0.3 },
  ghost: { alignItems: 'center', paddingVertical: 14 },
  ghostTxt: { fontSize: 14 },

  ride: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1.5, borderRadius: 16, padding: 10, marginBottom: 10 },
  rideIcon: { width: 54, height: 54, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  rideImg: { width: 44, height: 44 },
  rideNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rideName: { fontSize: 16, fontWeight: '800' },
  rideSub: { fontSize: 12, marginTop: 2 },
  ridePrice: { fontSize: 17, fontWeight: '800' },
  tag: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  tagTxt: { fontSize: 9, fontWeight: '800', letterSpacing: 0.8 },
  fine: { fontSize: 12, textAlign: 'center', marginTop: 4, lineHeight: 17 },

  ticket: { borderRadius: 22, borderWidth: 1, overflow: 'hidden', shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.18, shadowRadius: 22, elevation: 8 },
  ticketHead: { paddingHorizontal: 16, paddingVertical: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  ticketBrand: { color: '#FFFFFF', fontSize: 11, fontWeight: '800', letterSpacing: 1.6 },
  ticketCode: { color: BRAND.cyan, fontSize: 15, fontWeight: '800', letterSpacing: 2 },
  ticketBody: { padding: 16 },
  routeRow: { flexDirection: 'row', alignItems: 'center' },
  routeCol: { flex: 1 },
  routeMid: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  routeDot: { width: 8, height: 8, borderRadius: 4, borderWidth: 2 },
  routeDash: { flex: 1, height: 0, borderTopWidth: 1.5, borderStyle: 'dashed', marginHorizontal: 4 },
  small: { fontSize: 10, fontWeight: '700', letterSpacing: 1.8 },
  place: { fontSize: 16, fontWeight: '800', marginTop: 3 },
  statRow: { flexDirection: 'row', marginTop: 16 },
  stat: { fontSize: 15, fontWeight: '800', marginTop: 3 },
  perf: { height: 24, justifyContent: 'center' },
  perfLine: { marginHorizontal: 18, borderTopWidth: 1.5, borderStyle: 'dashed' },
  notch: { position: 'absolute', top: 0, width: 24, height: 24, borderRadius: 12, borderWidth: 1 },
  ticketFoot: { padding: 16, paddingTop: 8, flexDirection: 'row', alignItems: 'center', gap: 12 },
  fare: { fontSize: 28, fontWeight: '800', marginTop: 2, letterSpacing: -0.5 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, marginTop: 8 },
  statusTxt: { fontSize: 11, fontWeight: '700' },
  bars: { flexDirection: 'row', alignItems: 'flex-end', maxWidth: 150, overflow: 'hidden' },
});
