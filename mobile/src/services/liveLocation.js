// mobile/src/services/liveLocation.js — the app-wide driver / courier GPS service (see liveLocationCore.js).
//
//   import liveLocation from '../services/liveLocation';
//   useEffect(() => { liveLocation.acquire('active-ride', 'DRIVER'); return () => liveLocation.release('active-ride'); }, []);
//   useEffect(() => liveLocation.subscribe(({ status, fix }) => { ... }), []);
//
// Each fix is sent over the socket (with heading, speed and accuracy) and handed to subscribers. If the server answers
// "location:rejected / LOCATION_CONSENT_REQUIRED" the watcher stops and subscribers see status 'consent_required'.
import * as Location from '../shims/Location';   // same import the screens use: expo-location on phones, the browser shim on web
import socketService from './socket';
import { LiveLocationCore } from './liveLocationCore';

const core = new LiveLocationCore({ location: Location, send: (ping) => socketService.updateLocation(ping) });

const onRejected = (msg) => { if (msg?.reason === 'LOCATION_CONSENT_REQUIRED') core.consentRequired(); };
const onWithdrawn = () => core.consentRequired();   // consent withdrawn from another device / the consent screen

const liveLocation = {
  /** role: 'DRIVER' | 'DELIVERY_PARTNER' (decides the socket event names) */
  async acquire(owner, role) {
    if (role) socketService.setRole(role);
    socketService.off('location:rejected', onRejected);
    socketService.on('location:rejected', onRejected);
    socketService.off('location:consent:withdrawn', onWithdrawn);
    socketService.on('location:consent:withdrawn', onWithdrawn);
    return core.acquire(owner);
  },
  release(owner) {
    core.release(owner);
    if (core.owners.size === 0) { socketService.off('location:rejected', onRejected); socketService.off('location:consent:withdrawn', onWithdrawn); }
  },
  subscribe: (fn) => core.subscribe(fn),
  stop() { core.stop(); socketService.off('location:rejected', onRejected); socketService.off('location:consent:withdrawn', onWithdrawn); },
  get status() { return core.status; },
  get lastFix() { return core.last; },
  /** One-off reading (used when going online) without starting the watcher. */
  async current() {
    const perm = await Location.requestForegroundPermissionsAsync();
    if (perm?.status !== 'granted') throw new Error('PERMISSION_DENIED');
    const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    return p;
  },
};

export default liveLocation;
