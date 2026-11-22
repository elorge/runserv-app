// mobile/src/screens/Auth/EarnerPreviewScreen.js
//
// The Driver app's front door: "Earnings Simulator" (drivers) and "Parcel Run" (couriers).
//
// The customer app lets a new visitor PLAY with a trip and get a boarding pass before any sign-up form. This is the same
// idea for the people who earn on Runserv:
//
//   Driver   1 Vehicle -> 2 Week (hours, days) -> 3 Price (your ask) -> 4 Driver Pass
//   Courier  1 Parcel & distance -> 2 Shift & price -> 3 Courier Pass
//
// Creating an account "activates" the pass, and after sign-up the Road-to-online checklist picks up where the visitor is.
// Every choice is saved on the device as they go, so closing the app or finishing sign-up never loses them.
//
// Needs no account, no GPS and no map tiles. Fares and the standard commission come from the PUBLIC
// GET /rides/platform-rates, so the figures are the real rate card, shown as ESTIMATE RANGES (never a single income promise).
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated, Dimensions, StatusBar, ScrollView, Image, Easing } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../context/ThemeContext';
import PoweredBy from '../../components/PoweredBy';
import EarnMap from '../../components/earn/EarnMap';
import EarningsBreakdown from '../../components/earn/EarningsBreakdown';
import EarnerPass, { DRIVER_ACCENT, COURIER_ACCENT } from '../../components/earn/EarnerPass';
import DriverSteps from '../../components/earn/DriverSteps';
import CourierSteps from '../../components/earn/CourierSteps';
import { Cta } from '../../components/earn/EarnKit';
import { es, H_PAD } from '../../components/earn/earnStyles';
import { rideAPI } from '../../services/api';
import { resolveVehicleIconKey, vehicleIconSource } from '../../utils/vehicleIcons';
import { PREVIEW_VEHICLES, FALLBACK_RATES, formatMoneyFor } from '../../utils/tripEstimate';
import {
  ASSUMPTIONS, FALLBACK_COMMISSION, FALLBACK_DELIVERY, MAX_MULTIPLIER, safeCommission,
  driverTrip, driverWeek, askGain, courierShift, formatRange,
} from '../../utils/earningsEstimate';
import { loadEarnerDraft, saveEarnerDraft, newPassCode, isPassCodeForPath, markEarnerPreviewSeen, ROLE_FOR_PATH } from '../../services/earnerDraft';
import { useEarnT } from '../../i18n/earnerStrings';

const { width: W, height: H } = Dimensions.get('window');
const MAP_W = W - H_PAD * 2;
const MAP_H = Math.round(Math.min(280, Math.max(180, H * 0.28)));
const LOGO_DARK  = require('../../../assets/runserv_light.png');
const LOGO_LIGHT = require('../../../assets/runserv_dark.png');

const STEP_COUNT = { DRIVER: 4, COURIER: 3 };

export default function EarnerPreviewScreen({ navigation }) {
  const { theme, mode } = useTheme();
  const { t } = useTranslation();
  const e = useEarnT(t);
  const insets = useSafeAreaInsets();

  const [path, setPath] = useState(null);            // null = the chooser
  const [step, setStep] = useState(0);
  const [driver, setDriverState]   = useState({ vehicleType: 'CAR', hours: 8, days: [0, 1, 2, 3, 4], multiplier: 1 });
  const [courier, setCourierState] = useState({ km: 6, parcel: 'SMALL', shiftHours: 8, multiplier: 1 });
  const [passCode, setPassCode] = useState(() => newPassCode('DRIVER'));
  const [market, setMarket] = useState({
    rates: FALLBACK_RATES, delivery: FALLBACK_DELIVERY, commission: FALLBACK_COMMISSION,
    currency: 'NGN', countryCode: 'NG', roundingStep: 50, live: false,
  });
  const [restored, setRestored] = useState(false);

  const enter = useRef(new Animated.Value(1)).current;
  // Only keep a draft once the visitor has really engaged, so tapping "Sign In" straight away never leaves a phantom pass.
  const engaged = useRef(false);
  if (path && step >= 1) engaged.current = true;

  const setDriver = useCallback((p) => setDriverState((d) => ({ ...d, ...p })), []);
  const setCourier = useCallback((p) => setCourierState((c) => ({ ...c, ...p })), []);
  const toggleDay = useCallback((i) => setDriverState((d) => {
    const has = d.days.includes(i);
    if (has && d.days.length === 1) return d; // always work at least one day
    return { ...d, days: (has ? d.days.filter((x) => x !== i) : [...d.days, i]).sort() };
  }), []);

  // ── restore the last visit, then fetch the live rate card ───────────────────
  useEffect(() => {
    let alive = true;
    (async () => {
      const d = await loadEarnerDraft();
      if (alive && d) {
        engaged.current = true;
        if (d.driver) setDriverState(d.driver);
        if (d.courier) setCourierState(d.courier);
        setPassCode(d.passCode);
        setPath(d.path);
        setStep(Math.min(STEP_COUNT[d.path] - 1, d.step));
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
            delivery: { ...FALLBACK_DELIVERY, ...(p.delivery || {}) },
            // An older server may not send `commission` yet: then the standard fallback applies and the screen says "offline estimate".
            commission: {
              rides: safeCommission(p.commission?.rides, FALLBACK_COMMISSION.rides),
              delivery: safeCommission(p.commission?.delivery ?? p.delivery?.platformCommission, FALLBACK_COMMISSION.delivery),
            },
            currency: p.currency || 'NGN',
            countryCode: p.countryCode || 'NG',
            roundingStep: p.roundingStep || 50,
            live: p.commission?.rides != null,
          });
        }
      } catch { /* offline: the built-in rate card still gives a sensible estimate */ }
    })();
    return () => { alive = false; };
  }, []);

  const money = useCallback((n) => formatMoneyFor(n, market.currency), [market.currency]);
  const ng = market.countryCode === 'NG';

  // ── the numbers ─────────────────────────────────────────────────────────────
  const dKm = ASSUMPTIONS.driver.typicalTripKm;
  const driverCalc = useMemo(() => driverWeek({
    vehicleType: driver.vehicleType, hoursPerDay: driver.hours, daysPerWeek: driver.days.length, multiplier: driver.multiplier,
    rates: market.rates, roundingStep: market.roundingStep, commission: market.commission.rides,
  }), [driver, market]);
  const maxDay = useMemo(() => driverWeek({
    vehicleType: driver.vehicleType, hoursPerDay: 14, daysPerWeek: 1, multiplier: MAX_MULTIPLIER,
    rates: market.rates, roundingStep: market.roundingStep, commission: market.commission.rides,
  }).rawDay.high, [driver.vehicleType, market]);
  const quotes = useMemo(() => PREVIEW_VEHICLES.map((v) => ({
    v, ...driverTrip({ km: dKm, vehicleType: v, rates: market.rates, roundingStep: market.roundingStep, commission: market.commission.rides, multiplier: 1 }),
  })), [market, dKm]);
  const best = useMemo(() => quotes.reduce((a, b) => (b.earnings > a.earnings ? b : a)).v, [quotes]);
  const ask = useMemo(() => askGain({
    km: dKm, vehicleType: driver.vehicleType, rates: market.rates, roundingStep: market.roundingStep, commission: market.commission.rides, multiplier: driver.multiplier,
  }), [driver, market, dKm]);
  const courierCalc = useMemo(() => courierShift({
    km: courier.km, parcel: courier.parcel, shiftHours: courier.shiftHours, multiplier: courier.multiplier,
    delivery: market.delivery, roundingStep: market.roundingStep, commission: market.commission.delivery,
  }), [courier, market]);

  // ── words ───────────────────────────────────────────────────────────────────
  const letters = useMemo(() => e('dayLetters').split(','), [e]);
  const names = useMemo(() => e('dayNames').split(','), [e]);
  const vehicleName = (v) => {
    if (v === 'TRICYCLE')   return ng ? 'Keke' : e('vTricycle');
    if (v === 'MOTORCYCLE') return ng ? 'Okada' : e('vMoto');
    if (v === 'VAN')        return e('vVan');
    return e('vCar');
  };
  const vehicleSub = (v) => e({ TRICYCLE: 'subTricycle', MOTORCYCLE: 'subMoto', CAR: 'subCar', VAN: 'subVan' }[v]);
  const parcelName = (p) => e({ DOCUMENT: 'pDocument', SMALL: 'pSmall', MEDIUM: 'pMedium', LARGE: 'pLarge' }[p]);
  const parcelSub = (p) => e({ DOCUMENT: 'pDocumentSub', SMALL: 'pSmallSub', MEDIUM: 'pMediumSub', LARGE: 'pLargeSub' }[p]);

  const isDriver = path === 'DRIVER';
  const accent = isDriver ? DRIVER_ACCENT : COURIER_ACCENT;
  const ink = isDriver ? '#03170F' : '#1A1000';
  const lastStep = path ? STEP_COUNT[path] - 1 : 0;
  const onPass = !!path && step === lastStep;

  // ── persist every change, so the pass is never lost ─────────────────────────
  const summary = useMemo(() => (isDriver
    ? { kind: 'week', low: driverCalc.perWeek.low, high: driverCalc.perWeek.high, perTrip: driverCalc.trip.earnings, vehicleType: driver.vehicleType, hours: driver.hours, days: driver.days.length, multiplier: driver.multiplier }
    : { kind: 'run', pay: courierCalc.run.earnings, runsLow: courierCalc.runs.low, runsHigh: courierCalc.runs.high, km: courier.km, parcel: courier.parcel, shiftHours: courier.shiftHours, multiplier: courier.multiplier }),
  [isDriver, driverCalc, courierCalc, driver, courier]);

  useEffect(() => {
    if (!restored || !path || !engaged.current) return;
    saveEarnerDraft({ path, passCode, step, driver, courier, summary, currency: market.currency, countryCode: market.countryCode });
  }, [restored, path, passCode, step, driver, courier, summary, market.currency, market.countryCode]);

  const go = (next) => {
    enter.setValue(0);
    setStep(next);
    Animated.timing(enter, { toValue: 1, duration: 380, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  };
  const choosePath = (p) => {
    // Generate once, here; the persist effect saves this exact code (saveEarnerDraft no longer makes a second one).
    if (p && !isPassCodeForPath(passCode, p)) setPassCode(newPassCode(p));
    enter.setValue(0);
    setPath(p); setStep(0);
    Animated.timing(enter, { toValue: 1, duration: 380, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  };
  const back = () => (step > 0 ? go(step - 1) : choosePath(null));
  const leaveTo = async (screen, params) => { await markEarnerPreviewSeen(); navigation.navigate(screen, params); };

  // ── headings ────────────────────────────────────────────────────────────────
  const heading = !path
    ? { k: e('chEyebrow'), h: e('chTitle'), sub: e('chSub') }
    : { k: e(`${isDriver ? 'd' : 'c'}${step}Eyebrow`), h: e(`${isDriver ? 'd' : 'c'}${step}Title`), sub: e(`${isDriver ? 'd' : 'c'}${step}Sub`) };

  // ── the pass ────────────────────────────────────────────────────────────────
  const passData = useMemo(() => {
    if (isDriver) {
      const askLabel = driver.multiplier > 1 ? `${driver.multiplier.toFixed(2)}×` : e('standardShort');
      const headline = formatRange(driverCalc.perWeek.low, driverCalc.perWeek.high, money);
      return {
        vehicleIcon: vehicleIconSource(resolveVehicleIconKey(driver.vehicleType, { colour: 'blue' })),
        vehicleName: vehicleName(driver.vehicleType),
        schedule: e('passSchedule', { h: driver.hours, d: driver.days.length }),
        askLabel, letters, days: driver.days, headline,
        footnote: market.live ? e('passFootDriver') : e('passFootDriverOffline'),
        a11y: e('passA11yDriver', { vehicle: vehicleName(driver.vehicleType), h: driver.hours, d: driver.days.length, range: headline }),
      };
    }
    const c = courierCalc;
    return {
      parcelName: parcelName(courier.parcel), kmLabel: `${courier.km} km`, shiftLabel: `${courier.shiftHours} h`,
      askLabel: courier.multiplier > 1 ? `${courier.multiplier.toFixed(2)}×` : null,
      headline: money(c.run.earnings),
      footnote: e('passFootCourier', { lo: c.runs.low, hi: c.runs.high, h: courier.shiftHours }) + (market.live ? '' : ` ${e('offlineShort')}`),
      a11y: e('passA11yCourier', { parcel: parcelName(courier.parcel), km: courier.km, pay: money(c.run.earnings), lo: c.runs.low, hi: c.runs.high }),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDriver, driver, courier, driverCalc, courierCalc, market.live, money, e, letters]);

  const logo = mode === 'dark' ? LOGO_DARK : LOGO_LIGHT;
  const fade = { opacity: enter, transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }] };
  const glow = path ? accent : theme.accent;

  const ctx = {
    step, theme, mode, e, money, accent, ink, market, go,
    driver, setDriver, toggleDay, calc: isDriver ? driverCalc : courierCalc, quotes, best, maxDay, ask, letters, names, vehicleName, vehicleSub,
    courier, setCourier, parcelName, parcelSub,
  };

  return (
    <View style={[st.root, { backgroundColor: theme.background }]}>
      <StatusBar barStyle={mode === 'dark' ? 'light-content' : 'dark-content'} backgroundColor="transparent" translucent />
      <View style={[st.glow, { backgroundColor: glow }]} />

      {/* top bar */}
      <View style={[st.topBar, { paddingTop: insets.top + 8 }]}>
        <View style={st.brand}>
          {path ? (
            <TouchableOpacity onPress={back} accessibilityRole="button" accessibilityLabel={e('back')} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              style={[st.backBtn, { borderColor: theme.border, backgroundColor: theme.backgroundAlt }]}>
              <Ionicons name="chevron-back" size={18} color={theme.foreground} />
            </TouchableOpacity>
          ) : (
            <Image source={logo} style={st.logo} resizeMode="contain" />
          )}
          {path ? (
            <View style={st.dots} accessible accessibilityLabel={e('stepOf', { n: step + 1, total: STEP_COUNT[path] })}>
              {Array.from({ length: STEP_COUNT[path] }, (_, i) => (
                <View key={i} style={[st.dot, { backgroundColor: i <= step ? accent : theme.border, width: i === step ? 22 : 7 }]} />
              ))}
            </View>
          ) : null}
        </View>
        <TouchableOpacity onPress={() => leaveTo('Login')} accessibilityRole="button" hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={[st.signIn, { color: path ? accent : theme.accent }]}>{t('onboarding.signIn', { defaultValue: 'Sign In' })}</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 28 }} showsVerticalScrollIndicator={false} bounces={false}>
        <Animated.View style={[st.head, fade]}>
          <Text style={[st.eyebrow, { color: path ? accent : theme.accent }]}>{heading.k}</Text>
          <Text accessibilityRole="header" style={[st.title, { color: theme.foreground }]}>{heading.h}</Text>
          <Text style={[st.sub, { color: theme.muted }]}>{heading.sub}</Text>
        </Animated.View>

        {/* ───────────── CHOOSER ───────────── */}
        {!path && (
          <Animated.View style={[es.panel, fade]}>
            {[
              { p: 'DRIVER',  color: DRIVER_ACCENT,  img: vehicleIconSource(resolveVehicleIconKey('CAR', { colour: 'blue' })), title: e('chDriveTitle'), sub: e('chDriveSub'), cta: e('chDriveCta') },
              { p: 'COURIER', color: COURIER_ACCENT, img: vehicleIconSource(resolveVehicleIconKey('TRICYCLE', { cargo: true })), title: e('chDeliverTitle'), sub: e('chDeliverSub'), cta: e('chDeliverCta') },
            ].map((o) => (
              <TouchableOpacity key={o.p} activeOpacity={0.9} onPress={() => choosePath(o.p)} accessibilityRole="button" accessibilityLabel={`${o.title}. ${o.sub}`}
                style={[st.pathCard, { backgroundColor: theme.backgroundAlt, borderColor: o.color + '77', shadowColor: o.color }]}>
                <View style={[st.pathIcon, { backgroundColor: o.color + '22' }]}>
                  <Image source={o.img} style={st.pathImg} resizeMode="contain" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[st.pathTitle, { color: theme.foreground }]}>{o.title}</Text>
                  <Text style={[st.pathSub, { color: theme.muted }]}>{o.sub}</Text>
                  <View style={st.pathCtaRow}>
                    <Text style={[st.pathCta, { color: o.color }]}>{o.cta}</Text>
                    <Ionicons name="arrow-forward" size={14} color={o.color} />
                  </View>
                </View>
              </TouchableOpacity>
            ))}
            <Text style={[es.fineC, { color: theme.hint, marginTop: 6 }]}>{e('chFine')}</Text>
            <TouchableOpacity onPress={() => leaveTo('Register')} style={es.ghost}>
              <Text style={[es.ghostTxt, { color: theme.hint }]}>{e('skipCreate')}</Text>
            </TouchableOpacity>
          </Animated.View>
        )}

        {/* the living map: always on screen once a path is chosen, reacts to every choice */}
        {!!path && (
          <View style={{ paddingHorizontal: H_PAD }}>
            {isDriver ? (
              <EarnMap variant="DRIVER" width={MAP_W} height={MAP_H} theme={theme} mode={mode} accent={accent}
                vehicleType={driver.vehicleType} share={driverCalc.share} pingLabel={`+${money(driverCalc.trip.earnings)}`} />
            ) : (
              <EarnMap variant="COURIER" width={MAP_W} height={MAP_H} theme={theme} mode={mode} accent={accent}
                vehicleType={courier.parcel === 'LARGE' ? 'VAN' : courier.parcel === 'MEDIUM' ? 'TRICYCLE' : 'MOTORCYCLE'} cargo
                km={courier.km} label={`${courier.km} km`} />
            )}
          </View>
        )}

        {path && !onPass && (
          <Animated.View key={`${path}-${step}`} style={fade}>
            {isDriver ? <DriverSteps ctx={ctx} /> : <CourierSteps ctx={{ ...ctx, calc: courierCalc }} />}
          </Animated.View>
        )}

        {/* ───────────── PASS ───────────── */}
        {path && onPass && (
          <Animated.View style={[es.panel, fade]}>
            <EarnerPass path={path} passCode={passCode} theme={theme} mode={mode} e={e} activated={false} data={passData} />
            {isDriver ? (
              <EarningsBreakdown kind="DRIVER" trip={driverCalc.trip} runs={{ low: Math.round(driverCalc.tripsPerDay.low), high: Math.round(driverCalc.tripsPerDay.high) }}
                asking={driver.multiplier > 1} theme={theme} e={e} money={money} accent={accent} />
            ) : (
              <EarningsBreakdown kind="COURIER" trip={courierCalc.run} runs={courierCalc.runs} asking={courier.multiplier > 1} theme={theme} e={e} money={money} accent={accent} />
            )}
            <Cta onPress={() => leaveTo('Register', { role: ROLE_FOR_PATH[path] })} label={e('activate')} color={accent} ink={ink} />
            <TouchableOpacity onPress={() => leaveTo('Login')} style={es.ghost}>
              <Text style={[es.ghostTxt, { color: theme.hint }]}>
                {t('onboarding.haveAccount', { defaultValue: 'Have an account?' })}{' '}
                <Text style={{ color: accent, fontWeight: '700' }}>{t('onboarding.signIn', { defaultValue: 'Sign In' })}</Text>
              </Text>
            </TouchableOpacity>
            <Text style={[es.fineC, { color: theme.hint }]}>{e('passSaved')}</Text>
            <PoweredBy />
          </Animated.View>
        )}
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1 },
  glow: { position: 'absolute', width: W * 1.3, height: W * 1.3, borderRadius: W * 0.65, top: -W * 0.85, alignSelf: 'center', opacity: 0.09 },
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
  pathCard: { flexDirection: 'row', alignItems: 'center', gap: 14, borderWidth: 1.5, borderRadius: 22, padding: 14, marginBottom: 14, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.16, shadowRadius: 18, elevation: 6 },
  pathIcon: { width: 76, height: 76, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  pathImg: { width: 62, height: 62 },
  pathTitle: { fontSize: 20, fontWeight: '800', letterSpacing: -0.3 },
  pathSub: { fontSize: 13, lineHeight: 18, marginTop: 3 },
  pathCtaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  pathCta: { fontSize: 13, fontWeight: '800' },
});
