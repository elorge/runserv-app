// mobile/src/services/socket.js
import { io } from 'socket.io-client';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE_URL } from '../config/constants';

const SOCKET_URL = API_BASE_URL.replace('/api', '');

class SocketService {
  socket = null;
  _pendingListeners = [];
  _connectCallbacks = [];
  _isOnline = false;
  _lastLocation = null;
  _role = 'DRIVER';          // 'DRIVER' | 'DELIVERY_PARTNER': decides the event prefix (driver:* or partner:*)

  setRole(role) { if (role === 'DRIVER' || role === 'DELIVERY_PARTNER') this._role = role; }
  get _prefix() { return this._role === 'DELIVERY_PARTNER' ? 'partner' : 'driver'; }

  async connect() {
    // Already connected — flush any listeners queued before this call
    if (this.socket?.connected) {
      for (const { event, callback } of this._pendingListeners) {
        this.socket.on(event, callback);
      }
      this._pendingListeners = [];
      return;
    }

    // Already connecting — wait for it
    if (this.socket && !this.socket.connected) {
      return new Promise((resolve) => {
        this._connectCallbacks.push(resolve);
      });
    }

    let token = await AsyncStorage.getItem('authToken');

// Token may not have flushed to AsyncStorage yet on Android — retry once
if (!token) {
  await new Promise(r => setTimeout(r, 200));
  token = await AsyncStorage.getItem('authToken');
}
if (!token) {
  console.warn('[Socket] No auth token — skipping connect');
  return;
}

    console.log('[Socket] Connecting to:', SOCKET_URL);
    this.socket = io(SOCKET_URL, {
      auth: { token },
      transports: ['polling', 'websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 10,
      timeout: 20000,
    });

this.socket.on('connect', () => {
  console.log('[Socket] Connected:', this.socket.id);

  for (const { event, callback } of this._pendingListeners) {
    this.socket.on(event, callback);
  }
  this._pendingListeners = [];

  setTimeout(() => {
    for (const cb of this._connectCallbacks) cb();
    this._connectCallbacks = [];
  }, 0);

  // Re-announce online if the driver / courier was online before the reconnect. The server only lets them back into the
  // dispatch pool if their location consent is still valid.
  if (this._isOnline && this._lastLocation) {
    this.socket.emit(`${this._prefix}:online`, this._lastLocation);
  }

  // flush any goOnline call that fired before the socket was ready
  if (this._pendingOnline) {
    this.socket.emit(`${this._prefix}:online`, this._pendingOnline);
    this._pendingOnline = null;
  }
});

    this.socket.on('disconnect', (reason) => {
      console.log('[Socket] Disconnected:', reason);
    });

    this.socket.on('connect_error', (err) => {
  console.warn('[Socket] Connection error:', err.message, '| URL:', SOCKET_URL);
});
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this._pendingListeners = [];
    this._connectCallbacks = [];
  }

  // ── Driver helpers ────────────────────────────────────────────────────────

goOnline(location) {
  this._isOnline = true;
  this._lastLocation = { lat: location.latitude, lng: location.longitude };

  if (!this.socket?.connected) {
    // Socket not ready yet — queue it, the connect handler will flush it
    this._pendingOnline = this._lastLocation;
    return;
  }
  this._pendingOnline = null;
  this.socket.emit(`${this._prefix}:online`, this._lastLocation);
}

  goOffline() {
    this._isOnline = false;
    this._lastLocation = null;
    if (!this.socket?.connected) return;
    this.socket.emit(`${this._prefix}:offline`);
  }

  /**
   * One GPS fix. Sends heading, speed (m/s), accuracy (m) and the fix's own timestamp as well as the position, so the
   * server can validate the ping and the customer's map can turn the vehicle the right way.
   */
  updateLocation(fix) {
    if (!this.socket?.connected) return;
    this._lastLocation = { lat: fix.latitude, lng: fix.longitude };
    this.socket.emit(`${this._prefix}:location`, {
      lat: fix.latitude,
      lng: fix.longitude,
      ...(Number.isFinite(fix.accuracy)  ? { accuracy:  fix.accuracy }  : {}),
      ...(Number.isFinite(fix.heading)   ? { heading:   fix.heading }   : {}),
      ...(Number.isFinite(fix.speed)     ? { speed:     fix.speed }     : {}),
      ...(Number.isFinite(fix.timestamp) ? { timestamp: fix.timestamp } : {}),
    });
  }

  // ── Ride room helpers ─────────────────────────────────────────────────────

  joinRide(rideId) {
    if (!this.socket?.connected) return;
    this.socket.emit('ride:join', rideId);
  }

  leaveRide(rideId) {
    if (!this.socket?.connected) return;
    this.socket.emit('ride:leave', rideId);
  }

  // ── Event listener helpers ────────────────────────────────────────────────

  on(event, callback) {
    if (this.socket?.connected) {
      this.socket.on(event, callback);
    } else {
      // Only queue — do NOT attach to socket.io directly yet.
      // Attaching before connected means the listener fires before
      // the server has joined this socket to user:X room, causing
      // missed targeted events on first connect.
      this._pendingListeners.push({ event, callback });
    }
  }

  off(event, callback) {
    if (this.socket) {
      this.socket.off(event, callback);
    }
    // Also remove from the pending queue in case it never attached
    this._pendingListeners = this._pendingListeners.filter(
      (l) => !(l.event === event && l.callback === callback)
    );
  }

  get isConnected() {
    return this.socket?.connected ?? false;
  }
  
// Call this from your app's AppState listener
handleAppForeground() {
  if (!this.socket?.connected) {
    console.log('[Socket] App foregrounded — reconnecting...');
    this.connect().catch(() => {});
  }
}
}

export default new SocketService();