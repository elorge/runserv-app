// mobile/src/utils/dispatchStatus.js — helpers for the "why am I not receiving jobs?" screen.

export const REASON_ICON = {
  NO_PROFILE: 'person-add-outline',
  PROFILE_PENDING: 'time-outline',
  PROFILE_REJECTED: 'close-circle-outline',
  FLEET_NOT_ACTIVE: 'business-outline',
  VEHICLE_NOT_ACTIVE: 'car-outline',
  DOC_MISSING: 'document-outline',
  DOC_EXPIRED: 'calendar-outline',
};

/** i18n key for a server reason code; the screen falls back to the server's own message for unknown codes. */
export const reasonKey = (code) => `dispatchStatus.reason_${code}`;
export const warningKey = (code) => `dispatchStatus.warning_${code}`;

/**
 * Show the dashboard banner only when it adds something the dashboard does not already say: a fleet driver who cannot
 * take jobs, or a fleet vehicle with a document about to expire. Plain "profile pending" has its own existing banner.
 */
export const shouldShowBanner = (status) => {
  if (!status || !status.isFleetDriver) return false;
  return (status.reasons?.length ?? 0) > 0 || (status.warnings?.length ?? 0) > 0;
};

export const bannerTone = (status) => ((status?.reasons?.length ?? 0) > 0 ? 'blocked' : 'warning');
