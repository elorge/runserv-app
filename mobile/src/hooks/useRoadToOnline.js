// mobile/src/hooks/useRoadToOnline.js
//
// Loads the driver's / courier's server profile and derives the "Road to online" checklist from it (utils/roadToOnline.js).
// The last result is cached on the device, so the checklist shows instantly on a cold start or without signal and is then
// refreshed: "leave and come back to the same step" works even offline. The server stays the source of truth.
import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { driverAPI, partnerAPI } from '../services/api';
import { deriveRoad } from '../utils/roadToOnline';
import { getDocSlots as driverSlots } from '../screens/Driver/DriverDocumentsScreen';
import { getDocSlots as partnerSlots } from '../screens/Partner/PartnerDocumentsScreen';

const cacheKey = (role) => `@runserv_road_${role}`;

/** Profile fields of the documents this role + vehicle type must provide (same slots the upload screens show). */
export const requiredDocKeys = (role, vehicleType) => {
  const slots = role === 'DRIVER' ? driverSlots(vehicleType || 'CAR', (k) => k) : partnerSlots(vehicleType || 'BIKE');
  return slots.filter((s) => s.required).map((s) => s.key);
};

const isNotFound = (err) =>
  err?.statusCode === 404 || err?.status === 404 || err?.response?.status === 404 || /not found/i.test(err?.message || '');

/** Pure: server profile (or null) -> road. Exported so a dashboard that already holds the profile can reuse it. */
export const roadFromProfile = (role, profile) =>
  deriveRoad({ role, profile, requiredKeys: profile ? requiredDocKeys(role, profile.vehicleType) : [] });

export default function useRoadToOnline(role) {
  const [road, setRoad] = useState(null);
  const [vehicleType, setVehicleType] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(cacheKey(role));
        const c = raw ? JSON.parse(raw) : null;
        if (alive.current && c?.road) { setRoad((cur) => cur || c.road); setVehicleType((cur) => cur || c.vehicleType || null); }
      } catch { /* no cache: fine */ }
    })();
    return () => { alive.current = false; };
  }, [role]);

  const refresh = useCallback(async () => {
    setError(false);
    try {
      const res = role === 'DRIVER' ? await driverAPI.getProfile() : await partnerAPI.getProfile();
      const profile = res?.data?.profile ?? res?.profile ?? null;
      const next = roadFromProfile(role, profile);
      if (!alive.current) return;
      setRoad(next); setVehicleType(profile?.vehicleType || null);
      AsyncStorage.setItem(cacheKey(role), JSON.stringify({ road: next, vehicleType: profile?.vehicleType || null, savedAt: Date.now() })).catch(() => {});
    } catch (err) {
      if (!alive.current) return;
      if (isNotFound(err)) {            // no profile yet: the very first step
        const next = roadFromProfile(role, null);
        setRoad(next);
        AsyncStorage.setItem(cacheKey(role), JSON.stringify({ road: next, vehicleType: null, savedAt: Date.now() })).catch(() => {});
      } else setError(true);            // offline etc.: keep showing the cached road
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [role]);

  useEffect(() => { refresh(); }, [refresh]);

  return { road, vehicleType, loading, error, refresh };
}
