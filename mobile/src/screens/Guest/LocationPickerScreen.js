// mobile/src/screens/Guest/LocationPickerScreen.js
// Reusable location picker for the guest Trip Planner (M16 §3.1).
//   route.params: { field: 'pickup' | 'destination', countryCode, other?: place, initial?: place }
//   Returns to TripPlanner with params.picked = { field, place, at } where place = { latitude, longitude, address, label, placeId? }.
// Three ways in: search (debounced, one Places session per search), a centre pin on the map, and "Use my current location".
// Location permission is asked ONLY when the person taps that button; nothing is tracked in the background.
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, ScrollView, StatusBar, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../context/ThemeContext';
import { guestAPI } from '../../services/api';
import MapView from '../../components/SmartMapView';
import { getCountryCenter, regionAround } from '../../utils/countryGeo';
import { newSessionToken, needsDetails, toPlace } from '../../utils/guestPlanner';
import { normalizeLocation, validateLocation, addressFromReverse, reverseErrorKey, LOCATION_ERRORS, SEARCH_DEBOUNCE_MS, SEARCH_MIN_CHARS } from '../../utils/guestLocation';

const RED = '#DC2626';

export default function LocationPickerScreen({ navigation, route }) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const { field = 'pickup', countryCode = 'NG', other = null, initial = null } = route.params || {};
  const title = field === 'pickup' ? 'Choose pickup' : 'Choose destination';

  const [mode, setMode] = useState('search');                 // 'search' | 'map'
  const [text, setText] = useState('');
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);            // distinguishes "no results" from "not searched yet"
  const [candidate, setCandidate] = useState(initial ? normalizeLocation(initial) : null);
  const [resolving, setResolving] = useState(false);
  const [notice, setNotice] = useState(null);                 // { key } from LOCATION_ERRORS
  const [locating, setLocating] = useState(false);
  const [canAskAgain, setCanAskAgain] = useState(true);

  const sessionToken = useRef(newSessionToken());             // one Places session per search, renewed after a pick
  const timer = useRef(null);
  const seq = useRef(0);
  const alive = useRef(true);
  const startCenter = useRef(initial ? { lat: initial.latitude, lng: initial.longitude } : getCountryCenter(countryCode)).current;

  useEffect(() => () => { alive.current = false; clearTimeout(timer.current); }, []);

  const search = (v) => {
    setText(v); setNotice(null);
    clearTimeout(timer.current);
    if (v.trim().length < SEARCH_MIN_CHARS) { setItems([]); setSearched(false); return; }
    timer.current = setTimeout(async () => {
      const mine = ++seq.current; setBusy(true);
      try {
        const bias = other ? { lat: other.latitude, lng: other.longitude } : {};
        const res = await guestAPI.autocomplete({ input: v.trim(), sessionToken: sessionToken.current, countryCode, ...bias });
        if (alive.current && mine === seq.current) { setItems(res?.data?.suggestions || []); setSearched(true); }
      } catch { if (alive.current && mine === seq.current) { setItems([]); setSearched(true); } }
      finally { if (alive.current && mine === seq.current) setBusy(false); }
    }, SEARCH_DEBOUNCE_MS);
  };

  const pickSuggestion = async (s) => {
    setBusy(true); setNotice(null);
    try {
      const details = needsDetails(s) ? (await guestAPI.placeDetails({ placeId: s.placeId, sessionToken: sessionToken.current }))?.data : null;
      const p = toPlace(s, details);
      const loc = p && normalizeLocation({ latitude: p.latitude, longitude: p.longitude, address: p.label, placeId: s.placeId });
      if (!loc) { setNotice({ key: 'INVALID' }); return; }
      sessionToken.current = newSessionToken();
      setCandidate(loc); setItems([]); setText(''); setSearched(false);
    } catch { setNotice({ key: 'UNAVAILABLE' }); } finally { if (alive.current) setBusy(false); }
  };

  /** Resolve coordinates -> address (map pin and GPS). Falls back to letting the person type an address when it fails. */
  const resolve = useCallback(async (latitude, longitude) => {
    setResolving(true); setNotice(null);
    try {
      const { address } = addressFromReverse(await guestAPI.reverse({ lat: latitude, lng: longitude, countryCode }));
      if (!alive.current) return;
      const loc = normalizeLocation({ latitude, longitude, address });
      if (loc) setCandidate(loc); else { setCandidate(null); setNotice({ key: 'REVERSE_FAILED' }); }
    } catch (e) { if (alive.current) { setCandidate(null); setNotice({ key: reverseErrorKey(e) }); } }
    finally { if (alive.current) setResolving(false); }
  }, [countryCode]);

  const onRegionDone = useCallback((region) => { if (mode === 'map' && region) resolve(region.latitude, region.longitude); }, [mode, resolve]);

  const useMyLocation = async () => {
    setLocating(true); setNotice(null);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();      // asked now, on the tap, not at launch
      setCanAskAgain(perm.canAskAgain !== false);
      if (perm.status !== 'granted') { setNotice({ key: 'PERMISSION_DENIED' }); return; }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      await resolve(pos.coords.latitude, pos.coords.longitude);              // person still confirms the resolved address below
    } catch { setNotice({ key: 'UNAVAILABLE' }); } finally { if (alive.current) setLocating(false); }
  };

  const check = candidate ? validateLocation(candidate, other) : null;
  const confirm = () => {
    if (!candidate || !check?.ok) return;
    navigation.navigate({ name: 'TripPlanner', params: { picked: { field, place: candidate, at: Date.now() } }, merge: true });
  };
  const err = notice ? LOCATION_ERRORS[notice.key] : (check && !check.ok ? LOCATION_ERRORS[check.reason] : null);

  return (
    <View style={[st.root, { backgroundColor: theme.background }]}>
      <StatusBar barStyle="default" backgroundColor="transparent" translucent />
      <View style={[st.top, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} accessibilityRole="button" accessibilityLabel="Back" style={[st.back, { borderColor: theme.border, backgroundColor: theme.backgroundAlt }]}>
          <Ionicons name="chevron-back" size={18} color={theme.foreground} />
        </TouchableOpacity>
        <Text accessibilityRole="header" style={[st.title, { color: theme.foreground }]}>{title}</Text>
        <View style={{ width: 36 }} />
      </View>

      <View style={st.tabs}>
        {[['search', 'Search', 'search'], ['map', 'Pin on map', 'pin-outline']].map(([k, l, ic]) => (
          <TouchableOpacity key={k} onPress={() => setMode(k)} accessibilityRole="button" accessibilityState={{ selected: mode === k }}
            style={[st.tab, { borderColor: mode === k ? theme.accent : theme.border, backgroundColor: mode === k ? theme.accent + '1A' : theme.backgroundAlt }]}>
            <Ionicons name={ic} size={15} color={mode === k ? theme.accent : theme.muted} />
            <Text style={{ color: mode === k ? theme.accent : theme.foreground, fontWeight: '700', fontSize: 13 }}>{l}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <TouchableOpacity onPress={useMyLocation} disabled={locating} accessibilityRole="button" accessibilityLabel="Use my current location"
        style={[st.gps, { borderColor: theme.border, backgroundColor: theme.backgroundAlt }]}>
        {locating ? <ActivityIndicator size="small" color={theme.accent} /> : <Ionicons name="locate" size={18} color={theme.accent} />}
        <View style={{ flex: 1 }}>
          <Text style={{ color: theme.foreground, fontWeight: '700' }}>Use my current location</Text>
          <Text style={{ color: theme.hint, fontSize: 11 }}>Used once to fill this box. We do not track you.</Text>
        </View>
      </TouchableOpacity>

      {mode === 'search' ? (
        <ScrollView keyboardShouldPersistTaps="handled" style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 16 }}>
          <View style={[st.box, { backgroundColor: theme.backgroundAlt, borderColor: theme.border }]}>
            <Ionicons name="search" size={18} color={theme.muted} />
            <TextInput value={text} onChangeText={search} placeholder="Search an address or place" placeholderTextColor={theme.hint} autoFocus autoCorrect={false}
              style={[st.input, { color: theme.foreground }]} accessibilityLabel="Search an address or place" maxLength={100} />
            {busy ? <ActivityIndicator size="small" color={theme.accent} /> : null}
          </View>
          {items.map((s) => (
            <TouchableOpacity key={s.placeId} onPress={() => pickSuggestion(s)} accessibilityRole="button" style={[st.sugg, { borderColor: theme.border, backgroundColor: theme.backgroundAlt }]}>
              <Text numberOfLines={1} style={{ color: theme.foreground, fontWeight: '700' }}>{s.mainText || s.description}</Text>
              {s.secondaryText ? <Text numberOfLines={1} style={{ color: theme.muted, fontSize: 12 }}>{s.secondaryText}</Text> : null}
            </TouchableOpacity>
          ))}
          {searched && !busy && items.length === 0 ? <Text style={{ color: theme.muted, marginTop: 12 }}>No places found. Try a nearby landmark, or switch to “Pin on map”.</Text> : null}
        </ScrollView>
      ) : (
        <View style={{ flex: 1 }}>
          <MapView style={StyleSheet.absoluteFillObject} initialRegion={regionAround(startCenter, 0.01)} showsUserLocation={false} showsMyLocationButton={false} showsCompass={false} toolbarEnabled={false}
            onRegionChangeComplete={onRegionDone} />
          <View pointerEvents="none" style={st.pinWrap} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Ionicons name="location-sharp" size={40} color={field === 'pickup' ? theme.accent : RED} />
          </View>
          <Text style={[st.mapHint, { backgroundColor: theme.backgroundAlt, color: theme.muted }]}>Move the map so the pin sits on the exact spot.</Text>
        </View>
      )}

      <View style={[st.sheet, { paddingBottom: insets.bottom + 12, backgroundColor: theme.background, borderColor: theme.border }]}>
        {resolving ? <View style={st.row}><ActivityIndicator size="small" color={theme.accent} /><Text style={{ color: theme.muted }}>Finding the address…</Text></View> : null}
        {candidate && !resolving ? (
          <View style={st.row} accessibilityLiveRegion="polite">
            <Ionicons name="checkmark-circle" size={20} color={theme.accent} />
            <Text numberOfLines={2} style={{ flex: 1, color: theme.foreground, fontWeight: '700' }}>{candidate.address}</Text>
          </View>
        ) : null}
        {err ? <Text accessibilityLiveRegion="polite" style={{ color: RED, fontSize: 13, marginBottom: 8 }}>{err}</Text> : null}
        {notice?.key === 'PERMISSION_DENIED' && !canAskAgain ? (
          <TouchableOpacity onPress={() => Linking.openSettings?.()} accessibilityRole="button"><Text style={{ color: theme.accent, fontWeight: '700', marginBottom: 8 }}>Open settings</Text></TouchableOpacity>
        ) : null}
        <TouchableOpacity disabled={!candidate || !check?.ok || resolving} onPress={confirm} accessibilityRole="button"
          style={[st.cta, { backgroundColor: theme.accent, opacity: candidate && check?.ok && !resolving ? 1 : 0.45 }]}>
          <Text style={st.ctaTxt}>Confirm location</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 8 },
  back: { width: 36, height: 36, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 17, fontWeight: '800' },
  tabs: { flexDirection: 'row', gap: 8, paddingHorizontal: 20, marginBottom: 10 },
  tab: { flex: 1, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderRadius: 12, paddingVertical: 10 },
  gps: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 20, marginBottom: 10, borderWidth: 1, borderRadius: 14, padding: 12 },
  box: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1.5, borderRadius: 14, paddingHorizontal: 12, minHeight: 48, marginBottom: 8 },
  input: { flex: 1, fontSize: 15, paddingVertical: 10 },
  sugg: { borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 6 },
  pinWrap: { position: 'absolute', top: '50%', left: '50%', marginLeft: -20, marginTop: -40 },
  mapHint: { position: 'absolute', top: 10, alignSelf: 'center', fontSize: 12, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 10, overflow: 'hidden' },
  sheet: { paddingHorizontal: 20, paddingTop: 12, borderTopWidth: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  cta: { borderRadius: 14, paddingVertical: 15, alignItems: 'center' },
  ctaTxt: { color: '#fff', fontWeight: '800', fontSize: 15 },
});
