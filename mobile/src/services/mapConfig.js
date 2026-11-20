// mobile/src/services/mapConfig.js
// Runtime map settings, controlled from the admin console (Settings -> Maps). No rebuild needed to change them.
// Flow: start with env defaults -> load the cached copy -> fetch the latest from the server (at launch and when the app resumes).
import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api from './api';
import { normaliseMapConfig, envDefaultRenderer } from '../utils/mapRenderer';

const CACHE_KEY = 'runserv.mapConfig.v1';
const REFRESH_MS = 5 * 60 * 1000;

let state = normaliseMapConfig(
  { renderer: envDefaultRenderer(process.env.EXPO_PUBLIC_MAP_RENDERER), styleUrl: process.env.EXPO_PUBLIC_MAP_STYLE_URL || null, version: 0 },
);
const listeners = new Set();
let lastFetch = 0;
let started = false;

const emit = () => listeners.forEach((l) => l());
const set = (next) => {
  const n = normaliseMapConfig(next, state);
  if (n.renderer === state.renderer && n.styleUrl === state.styleUrl && n.version === state.version) return;
  state = n; emit();
};

export const getMapConfig = () => state;
const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };
export const useMapConfig = () => useSyncExternalStore(subscribe, getMapConfig, getMapConfig);

export async function refreshMapConfig({ force = false } = {}) {
  if (!force && Date.now() - lastFetch < REFRESH_MS) return state;
  lastFetch = Date.now();
  try {
    const res = await api.get('/public/map-config', { timeout: 6000 });
    const data = res?.data?.data ?? res?.data;
    if (data && typeof data === 'object') {
      set(data);
      AsyncStorage.setItem(CACHE_KEY, JSON.stringify(data)).catch(() => {});
    }
  } catch { /* offline or server down: keep what we have */ }
  return state;
}

/** Call once at app start. Safe to call repeatedly. */
export async function startMapConfig() {
  if (started) return;
  started = true;
  try {
    const cached = await AsyncStorage.getItem(CACHE_KEY);
    if (cached) set(JSON.parse(cached));
  } catch { /* ignore */ }
  refreshMapConfig({ force: true });
  AppState.addEventListener('change', (s) => { if (s === 'active') refreshMapConfig(); });
}
