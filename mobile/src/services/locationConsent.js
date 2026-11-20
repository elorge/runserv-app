// mobile/src/services/locationConsent.js
// The wording version a driver / courier agrees to. It MUST equal CONSENT_VERSION in backend/src/services/tracking.service.js.
// Change both together whenever the wording on LocationSharingScreen changes: everyone is then asked to agree again.
export const LOCATION_CONSENT_VERSION = '2026-11-v1';

export const isConsentRequiredError = (err) => err?.response?.data?.code === 'LOCATION_CONSENT_REQUIRED';
export const isConsentVersionError  = (err) => err?.response?.data?.code === 'LOCATION_CONSENT_VERSION';
export const isActiveTripError      = (err) => err?.response?.data?.code === 'LOCATION_CONSENT_ACTIVE_TRIP';
