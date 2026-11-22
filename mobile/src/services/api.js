// mobile/src/services/api.js
import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE_URL } from '../config/constants';
import { emitForceLogout } from './authEvents';
import { isGuestRequest, shapeRejection, shouldForceLogout } from './apiHelpers';
import * as FileSystem from 'expo-file-system/legacy';
import { toBase64DataUri } from '../utils/toBase64DataUri';

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
});

const uploadApi = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
});

uploadApi.interceptors.request.use(async (config) => {
  const token    = await AsyncStorage.getItem('authToken');
  const deviceId = await AsyncStorage.getItem('deviceId');

  if (token)    config.headers.Authorization = `Bearer ${token}`;
  if (deviceId) config.headers['X-Device-ID'] = deviceId;

  return config;
});

uploadApi.interceptors.response.use(
  (response) => response.data,
  (error)    => Promise.reject(error.response?.data ?? error)
);

// ── Device ID helper ──────────────────────────────────────────────────────────
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

// ── Request interceptor — attach auth token + device ID ──────────────────────
api.interceptors.request.use(
  async (config) => {
    const [token, deviceId] = await Promise.all([
      AsyncStorage.getItem('authToken'),
      getOrCreateDeviceId(),
    ]);
    // A guest-session call brings its own "Guest <token>" header: never overwrite it with a registered user's Bearer token.
    if (token && !isGuestRequest(config)) config.headers.Authorization = `Bearer ${token}`;
    config.headers['X-Device-ID'] = deviceId;
    return config;
  },
  (error) => Promise.reject(error)
);

// ── Response interceptor — unwrap .data, handle 401 ──────────────────────────
api.interceptors.response.use(
  (response) => response.data,
  async (error) => {
    if (shouldForceLogout(error)) {
      await AsyncStorage.multiRemove(['authToken', 'user']).catch(() => {});
      const reason = error.response?.data?.code ?? 'session_expired';
      emitForceLogout(reason);
    }
    // Rejects with the response body plus `status` (see apiHelpers.shapeRejection / utils/apiError.parseApiError).
    return Promise.reject(shapeRejection(error));
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────────────────────
export const authAPI = {
  register:       (data) => api.post('/auth/register', data),
  login:          (data) => api.post('/auth/login', data),
  googleSignIn:   (idToken) => api.post('/auth/google', { idToken }),
  requestPhone:   (data) => api.post('/auth/phone/request', data),   // { phone, countryCode }
  verifyPhone:    (data) => api.post('/auth/phone/verify', data),    // { code, tempToken, phoneToken }
  getCurrentUser: ()     => api.get('/auth/me'),
  logout:         ()     => api.post('/auth/logout'),

  // ── Password reset ─────────────────────────────────────────────────────────
  forgotPassword: (data) => api.post('/auth/forgot-password', data),
  resetPassword:  (data) => api.post('/auth/reset-password', data),

  // ── 2FA ───────────────────────────────────────────────────────────────────
  verifyOtp:  (data) => api.post('/auth/verify-otp', data),
  resendOtp:  (data) => api.post('/auth/resend-otp', data),
  setup2FA:   (data) => api.post('/auth/2fa/setup', data),
  enable2FA:  (data) => api.post('/auth/2fa/enable', data),
  confirm2FA: (data) => api.post('/auth/2fa/confirm', data),
  disable2FA: (data) => api.post('/auth/2fa/disable', data),

  resendVerification: (email) => api.post('/auth/resend-verification-email', { email }),
};

// ─────────────────────────────────────────────────────────────────────────────
// RIDE
// ─────────────────────────────────────────────────────────────────────────────
export const rideAPI = {
  getEstimate:           (params)   => api.get('/rides/estimate', { params }),
  requestRide:           (data)     => api.post('/rides/request', data),
  getActiveRide:         ()         => api.get('/rides/active'),
  getRideHistory:        (params)   => api.get('/rides/history', { params }),
  getRideById:           (id)       => api.get(`/rides/${id}`),
  acceptRide:            (id)       => api.put(`/rides/${id}/accept`),
  arrivedAtPickup:       (id)       => api.put(`/rides/${id}/arrived`),
  startRide:             (id)       => api.put(`/rides/${id}/start`),
  completeRide:          (id, data) => api.put(`/rides/${id}/complete`, data),
  cancelRide:            (id, data) => api.put(`/rides/${id}/cancel`, data),
  getNearbyDrivers:      (params)   => api.get('/rides/nearby-drivers', { params }),
  requestSpecificDriver: (data)     => api.post('/rides/request-driver', data),
  rateRide:              (id, data) => api.post(`/rides/${id}/rate`, data),
  getPlatformRates:      ()         => api.get('/rides/platform-rates'),
};

// ─────────────────────────────────────────────────────────────────────────────
// DELIVERY
// ─────────────────────────────────────────────────────────────────────────────
// Guest PLANNING only (public, preview): a real route + server-side signed estimates. It never creates a booking.
// Body: { service:'RIDE'|'PARCEL', countryCode, pickup:{latitude,longitude}, destination:{latitude,longitude}, parcel?:{category,weightKg,longestSideCm} }
export const guestAPI = {
  config:       ()     => api.get('/guest/config'),
  autocomplete: (data) => api.post('/guest/places/autocomplete', data),
  placeDetails: (data) => api.post('/guest/places/details', data),
  quote:        (data) => api.post('/guest/quote', data),
  // M15: reverse geocode for map pin / current location, phone verification for guest booking.
  reverse:      (data) => api.post('/guest/places/reverse', data),
  requestOtp:   (data) => api.post('/guest/otp/request', data),
  verifyOtp:    (data) => api.post('/guest/otp/verify', data),
};
// Guest-session calls use "Authorization: Guest <token>" (NOT the Bearer JWT) and a per-attempt Idempotency-Key.
const guestHeaders = (session, extra = {}) => ({ headers: { Authorization: `Guest ${session}`, ...extra } });
export const guestBookingAPI = {
  create:   (session, key, data) => api.post('/guest/bookings', data, guestHeaders(session, { 'Idempotency-Key': key })),
  list:     (session)            => api.get('/guest/bookings', guestHeaders(session)),
  get:      (session, id)        => api.get(`/guest/bookings/${id}`, guestHeaders(session)),
  cancel:   (session, id, reason) => api.post(`/guest/bookings/${id}/cancel`, { reason }, guestHeaders(session)),
  rotateTracking: (session, id)  => api.post(`/guest/bookings/${id}/tracking/rotate`, {}, guestHeaders(session)),
  revokeTracking: (session, id)  => api.post(`/guest/bookings/${id}/tracking/revoke`, {}, guestHeaders(session)),
  convert:  (session, data)      => api.post('/guest/convert', data, guestHeaders(session)),
  track:    (token)              => api.get(`/guest/track/${token}`),
};

export const deliveryAPI = {
  getEstimate:        (params)   => api.get('/deliveries/estimate', { params }),
  requestDelivery:    (data)     => api.post('/deliveries/request', data),
  getActiveDelivery:  ()         => api.get('/deliveries/active'),
  getDeliveryById:    (id)       => api.get(`/deliveries/${id}`),
  acceptDelivery:     (id)       => api.put(`/deliveries/${id}/accept`),
  pickupDelivery:     (id)       => api.put(`/deliveries/${id}/pickup`),
  startTransit:       (id)       => api.put(`/deliveries/${id}/transit`),
  completeDelivery:   (id, data) => api.put(`/deliveries/${id}/complete`, data),
  // M15 proof of delivery (courier). Server: POST /deliveries/:id/proof | /failed | /returned
  verifyProof:        (id, data) => api.post(`/deliveries/${id}/proof`, data),     // { code, photoUrl? }
  failDelivery:       (id, data) => api.post(`/deliveries/${id}/failed`, data),    // { reason, note?, photoUrl? }
  confirmReturned:    (id)       => api.post(`/deliveries/${id}/returned`, {}),
  cancelDelivery:     (id, data) => api.put(`/deliveries/${id}/cancel`, data),
  rateDelivery:       (id, data) => api.post(`/deliveries/${id}/rate`, data),
  getDeliveryHistory: (params)   => api.get('/deliveries/history', { params }),
  getNearbyPartners:  (params)   => api.get('/deliveries/nearby-partners', { params }),
};

// ─────────────────────────────────────────────────────────────────────────
// PLACES  (Google Places Autocomplete proxy, with automatic Photon fallback
// — see places.controller.js)
// ─────────────────────────────────────────────────────────────────────────
export const placesAPI = {
  autocomplete: (data) => api.post('/places/autocomplete', data),
  getDetails:   (data) => api.post('/places/details', data),
};

// ─────────────────────────────────────────────────────────────────────────────
// USER
// ─────────────────────────────────────────────────────────────────────────────
export const userAPI = {
  getProfile:              ()     => api.get('/users/profile'),
  updateProfile:           (data) => api.put('/users/profile', data),
  updatePassword:          (data) => api.put('/users/password', data),
  verifyPasswordChangeOtp: (data) => api.post('/users/password/verify-otp', data),
  getStats:                ()     => api.get('/users/stats'),
  submitFeedback:          (data) => api.post('/users/feedback', data),
  deleteAccount:           (data) => api.delete('/users/account', { data }), // ← NEW
};

// ─────────────────────────────────────────────────────────────────────────────
// DRIVER
// ─────────────────────────────────────────────────────────────────────────────
export const configAPI = {
  // M13: which vehicle categories are in service (the server enforces; the app only hides the rest)
  vehicleCategories: () => api.get('/public/vehicle-categories'),
};

export const driverAPI = {
  getProfile:         ()       => api.get('/drivers/profile'),
  updateProfile:      (data)   => api.post('/drivers/profile', data),
  updateStatus:       (data)   => api.put('/drivers/status', data),
  getEarnings:        (params) => api.get('/drivers/earnings', { params }),
  getStats:           ()       => api.get('/drivers/stats'),
  getNearbyRequests:  ()       => api.get('/drivers/nearby-requests'),
  requestPayout:      (data)   => api.post('/drivers/payout/request', data),
  getPayoutHistory:   (params) => api.get('/drivers/payout/history', { params }),
  uploadDocuments:    (data)   => api.post('/drivers/documents', data),
  setFloorMultiplier: (data)   => api.put('/drivers/floor-price', data),
  getDispatchStatus:  ()       => api.get('/drivers/dispatch-status'),
  getLocationConsent: ()       => api.get('/drivers/location-consent'),
  setLocationConsent: (granted, version) => api.put('/drivers/location-consent', { granted, version }),
};

// ─────────────────────────────────────────────────────────────────────────────
// PARTNER
// ─────────────────────────────────────────────────────────────────────────────
export const partnerAPI = {
  getProfile:         ()       => api.get('/partners/profile'),
  updateProfile:      (data)   => api.post('/partners/profile', data),
  updateStatus:       (data)   => api.put('/partners/status', data),
  getEarnings:        (params) => api.get('/partners/earnings', { params }),
  getStats:           ()       => api.get('/partners/stats'),
  getNearbyRequests:  ()       => api.get('/partners/nearby-requests'),
  uploadDocuments:    (data)   => api.post('/partners/documents', data),
  requestPayout:      (data)   => api.post('/partners/payout/request', data),
  getPayoutHistory:   (params) => api.get('/partners/payout/history', { params }),
  setFloorMultiplier: (data)   => api.put('/partners/floor-price', data),
  getDispatchStatus:  ()       => api.get('/partners/dispatch-status'),
  getLocationConsent: ()       => api.get('/partners/location-consent'),
  setLocationConsent: (granted, version) => api.put('/partners/location-consent', { granted, version }),
};

// ─────────────────────────────────────────────────────────────────────────────
// BANK OFFERS (customer)  — sponsored offers from partner banks
// ─────────────────────────────────────────────────────────────────────────────
export const offersAPI = {
  list:        ()            => api.get('/offers'),
  get:         (id)          => api.get(`/offers/${id}`),
  impressions: (offerIds)    => api.post('/offers/impressions', { offerIds }),
  click:       (id)          => api.post(`/offers/${id}/click`),
};

// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────────────
export const notificationAPI = {
  getNotifications: (params) => api.get('/notifications', { params }),
  getUnreadCount:   ()       => api.get('/notifications/count'),
  markAsRead:       (id)     => api.put(`/notifications/${id}/read`),
  markAllAsRead:    ()       => api.put('/notifications/read-all'),
  deleteOne:        (id)     => api.delete(`/notifications/${id}`),
  clearAll:         ()       => api.delete('/notifications'),
};

// ─────────────────────────────────────────────────────────────────────────────
// WALLET
// ─────────────────────────────────────────────────────────────────────────────
export const walletAPI = {
  getWallet:              ()       => api.get('/wallet'),
  getTransactions:        (params) => api.get('/wallet/transactions', { params }),
  lookupUser:             (phone)  => api.get('/wallet/lookup-user', { params: { phone } }),
  initializeTopUp:        (data)   => api.post('/wallet/topup/initialize', data),
  paystackTopup:          (data)   => api.post('/wallet/topup/paystack', data),
  verifyPaystackTopup:    (data)   => api.post('/wallet/topup/paystack/verify', data),
  flutterwaveTopup:       (data)   => api.post('/wallet/topup/flutterwave', data),
  verifyFlutterwaveTopup: (data)   => api.post('/wallet/topup/flutterwave/verify', data),
  // Orange Money. verifyOrangeTopup returns HTTP 202 (not an error) while
  // Orange still reports the payment as pending — see WalletTopUpScreen for
  // the polling loop that relies on this.
  orangeTopup:            (data)   => api.post('/wallet/topup/orange', data),
  verifyOrangeTopup:      (data)   => api.post('/wallet/topup/orange/verify', data),
  verifyBankAccount:      (params) => api.get('/wallet/verify-account', { params }),
  transfer:               (data)   => api.post('/wallet/transfer', data),
  withdraw:               (data)   => api.post('/wallet/withdraw', data),
  getDepositLimits:       ()       => api.get('/wallet/deposit-limits'),
  emailTransactionHistory:(data)   => api.post('/wallet/transactions/email', data),
};

// ─────────────────────────────────────────────────────────────────────────────
// PAYMENT
// ─────────────────────────────────────────────────────────────────────────────
export const paymentAPI = {
  initializePaystack:    (data)     => api.post('/payments/paystack/initialize', data),
  verifyPaystack:        (data)     => api.post('/payments/paystack/verify', data),
  initializeFlutterwave: (data)     => api.post('/payments/flutterwave/initialize', data),
  verifyFlutterwave:     (data)     => api.post('/payments/flutterwave/verify', data),
  initializeOrange:      (data)     => api.post('/payments/orange/initialize', data),
  // MTN MoMo: needs an existing booking (rideId | deliveryId) and a per-attempt Idempotency-Key header.
  initializeMomo:        (data, idempotencyKey) => api.post('/payments/momo/initialize', data, { headers: { 'Idempotency-Key': idempotencyKey } }),
  verifyMomo:            (data)     => api.post('/payments/momo/verify', data),
  verifyOrange:          (data)     => api.post('/payments/orange/verify', data),
  payWithWallet:         (data)     => api.post('/payments/wallet', data),
  payWithCash:           (data)     => api.post('/payments/cash', data),
  getHistory:            (params)   => api.get('/payments/history', { params }),
  getStats:              (params)   => api.get('/payments/stats', { params }),
  getById:               (id)       => api.get(`/payments/${id}`),
  requestRefund:         (id, data) => api.post(`/payments/${id}/refund`, data),
  listBanks:             (rail)     => api.get('/payments/banks', { params: rail ? { rail } : {} }),
  verifyBankAccount:     (data)     => api.post('/payments/verify-account', data),
};

// ─────────────────────────────────────────────────────────────────────────────
// SUPPORT TICKETS
// ─────────────────────────────────────────────────────────────────────────────
export const supportAPI = {
  submitTicket: (data)        => api.post('/users/support-ticket', data),
  getMyTickets: (params)      => api.get('/users/support-tickets', { params }),
  getTicketById:(id)          => api.get(`/users/support-tickets/${id}`),
  addReply:     (id, message) => api.post(`/users/support-tickets/${id}/reply`, { message }),
};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC SETTINGS  (no auth token required)
// ─────────────────────────────────────────────────────────────────────────────
export const settingsAPI = {
  getContactSettings: () => api.get('/status/contact'),
  getLegalContent:    () => api.get('/status/legal'),
};

// ─────────────────────────────────────────────────────────────────────────────
// COUNTRIES  (public, no auth token required — used pre-login at registration)
// ─────────────────────────────────────────────────────────────────────────────
export const countryAPI = {
  // forRole is optional: pass 'DRIVER' or 'DELIVERY_PARTNER' to filter out
  // countries where payoutMethod is still 'UNSUPPORTED'. Omit for customers.
  listForRegistration: (forRole) =>
    api.get('/countries', { params: forRole ? { forRole } : {} }),

  // Which payment methods this country offers, which to preselect, and
  // whether withdrawals use a bank form or a mobile-money form.
  getMyConfig: () => api.get('/countries/me/config'),

  // Same data for a country the user hasn't joined yet — used on the
  // registration screen to preview methods before an account exists.
  getConfig: (code) => api.get(`/countries/${code}/config`),
};

// ─────────────────────────────────────────────────────────────────────────────
// CORPORATE
// ─────────────────────────────────────────────────────────────────────────────
export const corporateAPI = {
  // ── Staff: join an organisation, see usage, ask for weekend rides ──
  lookup:              (code)   => api.get(`/corporate/lookup/${encodeURIComponent(code)}`),
  getMyAccount:        ()       => api.get('/corporate/my-account'),
  requestToJoin:       (data)   => api.post('/corporate/join-request', data),      // { orgCode, staffNumber }
  cancelJoinRequest:   ()       => api.delete('/corporate/join-request'),
  leave:               ()       => api.post('/corporate/leave'),
  getMyTrips:          (params) => api.get('/corporate/my-trips', { params }),
  requestWeekend:      (data)   => api.post('/corporate/my-weekend-requests', data), // { date: 'YYYY-MM-DD', reason }
  requestApproval:     (data)   => api.post('/corporate/my-approvals', data),         // trip above the approval limit
  cancelWeekend:       (id)     => api.delete(`/corporate/my-weekend-requests/${id}`),
  // ── Drivers / delivery partners: earnings from organisation trips ──
  getOrgEarnings:      ()       => api.get('/corporate/earnings/summary'),
  getOrgEarningTrips:  (params) => api.get('/corporate/earnings/trips', { params }),
};

// ─────────────────────────────────────────────────────────────────────────────
// FILE UPLOADS
// ─────────────────────────────────────────────────────────────────────────────

// ── Low-level multipart helper ────────────────────────────────────────────────
const uploadSingle = async (url, fieldName, file) => {
  const [token, deviceId] = await Promise.all([
    AsyncStorage.getItem('authToken'),
    AsyncStorage.getItem('deviceId'),
  ]);

  const uploadUrl = `${API_BASE_URL}${url}`;

  const result = await FileSystem.uploadAsync(uploadUrl, file.uri, {
    httpMethod: 'POST',
    uploadType: 'multipart',
    fieldName,
    mimeType: file.mimeType ?? file.type ?? 'image/jpeg',
    headers: {
      ...(token    && { Authorization: `Bearer ${token}` }),
      ...(deviceId && { 'X-Device-ID': deviceId }),
    },
  });

  if (result.status >= 400) {
    let body;
    try { body = JSON.parse(result.body); } catch { body = { message: result.body }; }
    return Promise.reject(body);
  }

  let body;
  try { body = JSON.parse(result.body); } catch { body = result.body; }
  return body;
};

// ── Helper — extract URL from any Cloudinary/upload response shape ────────────
const extractUrl = (res) =>
  res?.data?.url        ??
  res?.data?.secure_url ??
  res?.url              ??
  res?.secure_url       ??
  null;

// ── Base64 fallback — converts asset to data-URI then POSTs to /upload/base64 ─
const uploadViaBase64 = async (asset, folder) => {
  const dataUri = await toBase64DataUri(asset.uri);
  return api.post('/upload/base64', { base64Data: dataUri, folder });
};

// ── Generic upload with automatic base64 fallback ────────────────────────────
//    Tries multipart first; falls back to base64 if multipart fails.
//    Returns the resolved URL string (throws if both methods fail).
const uploadWithFallback = async (multipartUrl, fieldName, asset, folder) => {
  let url = null;

  try {
    url = extractUrl(await uploadSingle(multipartUrl, fieldName, asset));
  } catch (err) {
    console.warn(`[uploadAPI] multipart failed for ${multipartUrl}, trying base64:`, err?.message);
  }

  if (!url) {
    url = extractUrl(await uploadViaBase64(asset, folder));
  }

  if (!url) throw new Error('Upload succeeded but no URL was returned. Check Cloudinary config.');
  return url;
};

export const uploadAPI = {
  // M15: hand-over / failed-delivery photo, stored PRIVATELY. Returns a private reference to send as `photoUrl`
  // (no public link exists; support opens it through the audited document-access endpoint). No public base64 fallback on purpose.
  uploadPodPhoto: async (image) => {
    const ref = extractUrl(await uploadSingle('/upload/delivery/pod-photo', 'proof', image));
    if (!ref) throw new Error('Photo upload failed. Please try again.');
    return ref;
  },

  // ── Pre-existing driver document uploads ────────────────────────────────────
  uploadDriverLicense: (image) =>
    uploadSingle('/upload/driver/license', 'license', image),

  uploadVehicleRegistration: (image) =>
    uploadSingle('/upload/driver/vehicle-registration', 'registration', image),

  uploadInsurance: (image) =>
    uploadSingle('/upload/driver/insurance', 'insurance', image),

  // ── Pre-existing partner document uploads ───────────────────────────────────
  uploadPartnerId: (image) =>
    uploadSingle('/upload/partner/id', 'id', image),

  uploadPartnerVehicle: (image) =>
    uploadSingle('/upload/partner/vehicle', 'vehicle', image),

  // ── Profile image ───────────────────────────────────────────────────────────
  uploadProfileImage: (image) =>
    uploadSingle('/upload/profile-image', 'image', image),

  // ── Raw base64 upload (used as a direct fallback) ───────────────────────────
  uploadBase64: (base64, folder) =>
    api.post('/upload/base64', { base64Data: base64, folder }),

  // ── KYC — Personal identity ─────────────────────────────────────────────────
  uploadApplicantPhoto: (image) =>
    uploadWithFallback('/upload/kyc/applicant-photo', 'photo', image, 'runserv/kyc/photos'),

  uploadGovtId: (image) =>
    uploadWithFallback('/upload/kyc/govt-id', 'id', image, 'runserv/kyc/ids'),

  uploadProofOfAddress: (image) =>
    uploadWithFallback('/upload/kyc/proof-of-address', 'address', image, 'runserv/kyc/address'),

  // ── KYC — Vehicle condition ─────────────────────────────────────────────────
  uploadRoadWorthiness: (image) =>
    uploadWithFallback('/upload/kyc/road-worthiness', 'doc', image, 'runserv/kyc/roadworthy'),

  uploadVehicleInspection: (image) =>
    uploadWithFallback('/upload/kyc/vehicle-inspection', 'doc', image, 'runserv/kyc/inspection'),

  uploadHackneyCert: (image) =>
    uploadWithFallback('/upload/kyc/hackney-cert', 'doc', image, 'runserv/kyc/permits'),

  uploadVehicleExterior: (image) =>
    uploadWithFallback('/upload/kyc/vehicle-exterior', 'photo', image, 'runserv/kyc/vehicles'),

  uploadVehicleInterior: (image) =>
    uploadWithFallback('/upload/kyc/vehicle-interior', 'photo', image, 'runserv/kyc/vehicles'),

  // ── KYC — Motorcycle / Bike ─────────────────────────────────────────────────
  uploadRiderCard: (image) =>
    uploadWithFallback('/upload/kyc/rider-card', 'doc', image, 'runserv/kyc/permits'),

  uploadHelmetPhoto: (image) =>
    uploadWithFallback('/upload/kyc/helmet', 'photo', image, 'runserv/kyc/helmet'),

  uploadDispatchPermit: (image) =>
    uploadWithFallback('/upload/kyc/dispatch-permit', 'doc', image, 'runserv/kyc/permits'),

  uploadGuarantorLetter: (image) =>
    uploadWithFallback('/upload/kyc/guarantor-letter', 'doc', image, 'runserv/kyc/guarantor'),

  uploadGuarantorId: (image) =>
    uploadWithFallback('/upload/kyc/guarantor-id', 'id', image, 'runserv/kyc/guarantor'),

  // ── KYC — Tricycle ──────────────────────────────────────────────────────────
  uploadOperatorPermit: (image) =>
    uploadWithFallback('/upload/kyc/operator-permit', 'doc', image, 'runserv/kyc/permits'),

  // ── Convenience wrapper used by document screens ────────────────────────────
  //    Accepts an asset object and a Cloudinary folder string.
  //    Always resolves to the uploaded URL string (never an axios response object).
  uploadBase64AndReturn: async (asset, folder) => {
    const url = extractUrl(await uploadViaBase64(asset, folder));
    if (!url) throw new Error('Upload succeeded but no URL was returned. Check Cloudinary config.');
    return url;
  },
};

export default api;