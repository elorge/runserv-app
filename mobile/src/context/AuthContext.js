// mobile/src/context/AuthContext.js
import { registerDeviceToken, unregisterDeviceToken, requestUserPermission } from '../utils/notifications';
import React, { createContext, useState, useEffect, useRef, useContext } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert } from 'react-native';
import { authAPI } from '../services/api';
import { onForceLogout, suppressForceLogout } from '../services/authEvents';
import socketService from '../services/socket';
import { loadGuestSession, saveGuestSession, clearAllGuestState, clearCredential } from '../services/guestSession';
import { validateGuestSession, isRegisteredPayload } from '../utils/guestAuth';

const AuthContext = createContext();

const getOrCreateDeviceId = async () => {
  try {
    let id = await AsyncStorage.getItem('deviceId');
    if (!id) {
      id =
        Date.now().toString(36) + '-' +
        Math.random().toString(36).substring(2, 10) + '-' +
        Math.random().toString(36).substring(2, 10);
      await AsyncStorage.setItem('deviceId', id);
    }
    return id;
  } catch {
    return 'fallback-' + Math.random().toString(36).substring(2);
  }
};

export const AuthProvider = ({ children }) => {
  const [user,            setUser]            = useState(null);
  const [token,           setToken]           = useState(null);
  const [loading,         setLoading]         = useState(true);
  const [biometricLocked, setBiometricLocked] = useState(false);
  // M16: a GUEST (phone-verified) session lives apart from the registered user/token above. It is never written to authToken/user.
  const [guestSession,    setGuestSession]    = useState(null);

  const logoutRef = useRef(null);

  useEffect(() => { loadStoredAuth(); }, []);
  useEffect(() => { loadGuestSession().then(setGuestSession).catch(() => {}); }, []);

  useEffect(() => {
    const unsubscribe = onForceLogout((reason) => {
      setToken(null);
      setUser(null);
      setBiometricLocked(false);
      try { socketService.disconnect(); } catch {}
      const message =
        reason === 'device_conflict'
          ? 'Your account was signed in on another device. You have been signed out.'
          : 'Your session has expired. Please sign in again.';
      Alert.alert('Signed Out', message);
    });
    return unsubscribe;
  }, []);

  const loadStoredAuth = async () => {
    try {
      const [storedToken, storedUser] = await AsyncStorage.multiGet(['authToken', 'user']);
      const t = storedToken[1];
      const u = storedUser[1];
      if (t && u) {
        setToken(t);
        setUser(JSON.parse(u));
        socketService.connect().catch(() => {});
      }
    } catch (e) {
      console.error('Error loading auth:', e);
    } finally {
      setLoading(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // biometricLogin
  // ─────────────────────────────────────────────────────────────────────────
  const biometricLogin = async (secureToken) => {
    suppressForceLogout(true);
    try {
      await AsyncStorage.setItem('authToken', secureToken);
      const response = await authAPI.getCurrentUser();

      const u = response?.data?.user ?? response?.user ?? null;

      if (!u) {
        return { success: false, message: 'Could not retrieve your profile. Please sign in with your password.' };
      }

      await _persistSession(u, secureToken);
      return { success: true };
    } catch (error) {
      await AsyncStorage.multiRemove(['authToken', 'user']).catch(() => {});
      const message =
        error.response?.status === 401
          ? 'Your session has expired. Please sign in with your password.'
          : error.message || 'Biometric login failed.';
      return { success: false, message };
    } finally {
      suppressForceLogout(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // biometricUnlock — alias for biometricLogin (returns boolean for simplicity)
  // ─────────────────────────────────────────────────────────────────────────
  const biometricUnlock = async (secureToken) => {
    const result = await biometricLogin(secureToken);
    return result.success;
  };

  // ─────────────────────────────────────────────────────────────────────────
  // login
  // ─────────────────────────────────────────────────────────────────────────
  const login = async (credentials) => {
    try {
      const deviceId = await getOrCreateDeviceId();
      const response = await authAPI.login({ ...credentials, deviceId });

      if (response.requiresOtp || response.data?.requiresOtp) {
        return {
          success:       true,
          requiresOtp:   true,
          tempToken:     response.data?.tempToken     ?? response.tempToken,
          method:        response.data?.method        ?? response.method,
          maskedContact: response.data?.maskedContact ?? response.maskedContact,
        };
      }

      const { user: u, token: t } = response.data;
      await _persistSession(u, t);
      return { success: true, token: t };
    } catch (error) {
      const message =
        error.response?.data?.message ||
        error.response?.data?.errors?.[0]?.msg ||
        error.message || 'Login failed';
      return { success: false, message };
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // loginWithGoogle — Google ID token → Runserv session (creates the account on first use)
  // ─────────────────────────────────────────────────────────────────────────
  const loginWithGoogle = async (idToken) => {
    try {
      const response = await authAPI.googleSignIn(idToken);
      const { user: u, token: t, isNew, needsPhone } = response.data;
      await _persistSession(u, t);
      return { success: true, token: t, isNew, needsPhone };
    } catch (error) {
      return { success: false, message: error.response?.data?.message || error.message || 'Google sign-in failed' };
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // verifyOtp — completes 2FA login
  // ─────────────────────────────────────────────────────────────────────────
  const verifyOtp = async (code, tempToken) => {
    try {
      const response = await authAPI.verifyOtp({ code, tempToken });
      const { user: u, token: t } = response.data;
      await _persistSession(u, t);
      return { success: true, token: t };
    } catch (error) {
      return {
        success: false,
        message: error.response?.data?.message || 'Verification failed',
      };
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // resendOtp
  // ─────────────────────────────────────────────────────────────────────────
  const resendOtp = async (tempToken) => {
    try {
      const response = await authAPI.resendOtp({ tempToken });
      return { success: true, ...response.data };
    } catch (error) {
      return {
        success: false,
        message: error.response?.data?.message || 'Could not resend code',
      };
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // register
  // ─────────────────────────────────────────────────────────────────────────
  const register = async (userData) => {
    try {
      const deviceId = await getOrCreateDeviceId();
      const response = await authAPI.register({ ...userData, deviceId });

      // ✅ Handle email verification gate
      if (response.requiresVerification || response.data?.requiresVerification) {
        return {
          success: true,
          requiresVerification: true,
          email: response.data?.email ?? response.email,
        };
      }

      // ✅ Handle OTP gate
      if (response.requiresOtp || response.data?.requiresOtp) {
        return {
          success:       true,
          requiresOtp:   true,
          tempToken:     response.data?.tempToken     ?? response.tempToken,
          method:        response.data?.method        ?? response.method,
          maskedContact: response.data?.maskedContact ?? response.maskedContact,
        };
      }

      // ✅ Default: token issued immediately
      const { user: u, token: t } = response.data;
      await _persistSession(u, t);
      return { success: true, token: t };

    } catch (error) {
      let message = 'Registration failed';
      if (error.errors && Array.isArray(error.errors)) {
        message = error.errors.map(e => e.msg).join('\n');
      } else if (error.message) {
        message = error.message;
      }
      return { success: false, message };
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Biometric lock / unlock (simple state toggles)
  // ─────────────────────────────────────────────────────────────────────────
  const biometricLock      = () => setBiometricLocked(true);
  const biometricUnlockState = () => setBiometricLocked(false);

  // ─────────────────────────────────────────────────────────────────────────
  // updateUser / logout
  // ─────────────────────────────────────────────────────────────────────────
  const updateUser = async (updatedFields) => {
    const updated = { ...user, ...updatedFields };
    await AsyncStorage.setItem('user', JSON.stringify(updated));
    setUser(updated);
  };

  const logout = async () => {
    // WP-03/08: while the token is still valid, stop pushes to this device and revoke the session server-side.
    try { await unregisterDeviceToken(); } catch {}
    try { await authAPI.logout(); } catch {}
    setToken(null);
    setUser(null);
    setBiometricLocked(false);
    try { socketService.disconnect(); } catch {}
    try { await AsyncStorage.multiRemove(['authToken', 'user']); } catch {}
  };

  logoutRef.current = logout;

  // Register this device for push once signed in (and again after every app start).
  useEffect(() => { if (token && user) { requestUserPermission().then(() => registerDeviceToken()).catch(() => {}); } }, [token, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─────────────────────────────────────────────────────────────────────────
  // M16 guest session. Separate from the registered session on purpose.
  //   adoptSession(verifyResult) -> { success, message? }   (verifyResult = data of POST /guest/otp/verify)
  //   endGuestSession()          -> forget the guest credential on this device (expiry, "use a different number")
  //   completeConversion(data)   -> data of POST /guest/convert: start the REGISTERED session, then clear guest credentials
  // ─────────────────────────────────────────────────────────────────────────
  const adoptSession = async (gs) => {
    const v = validateGuestSession(gs);
    if (!v.ok) return { success: false, message: v.message };
    try {
      const saved = await saveGuestSession(v.session);
      setGuestSession(saved);
      return { success: true };
    } catch {
      // Fail closed: the credential was not stored, so the guest is NOT treated as verified and keeps their place in the flow.
      setGuestSession(null);
      return { success: false, message: 'We could not save your verification securely on this device. Nothing was lost: please try again.' };
    }
  };

  // M16.1: ending a guest session drops the CREDENTIAL only; the booking reference survives so the guest can re-verify and resume.
  const endGuestSession = async () => {
    setGuestSession(null);
    try { await clearCredential(); } catch { /* nothing left to clear */ }
  };

  const completeConversion = async (payload) => {
    if (!isRegisteredPayload(payload)) return { success: false, message: 'Your account was created but we could not sign you in. Please sign in with your email and password.' };
    await _persistSession(payload.user, payload.token);
    setGuestSession(null);
    try { await clearAllGuestState(); } catch { /* the account exists; leftovers are harmless */ }   // server-confirmed conversion: booking context goes too
    return { success: true };
  };

  // ─────────────────────────────────────────────────────────────────────────
  // _persistSession — write storage + update all React state in one shot
  // ─────────────────────────────────────────────────────────────────────────
  const _persistSession = async (u, t) => {
    await AsyncStorage.setItem('authToken', t);
    await AsyncStorage.setItem('user', JSON.stringify(u));
    setToken(t);
    setUser(u);
    setBiometricLocked(false);
    socketService.connect().catch(() => {});
  };

  return (
    <AuthContext.Provider value={{
      user, token, loading,
      guestSession, adoptSession, endGuestSession, completeConversion,
      biometricLocked,
      login, loginWithGoogle, register, logout, updateUser,
      biometricLogin,
      verifyOtp, resendOtp,
      biometricLock,
      biometricUnlock,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
};