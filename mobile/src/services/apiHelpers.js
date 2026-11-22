// mobile/src/services/apiHelpers.js — the pure parts of the API client (no React Native imports, so they are unit-testable).

const authHeaderOf = (config) => {
  const h = config?.headers;
  const v = typeof h?.get === 'function' ? h.get('Authorization') : h?.Authorization;
  return typeof v === 'string' ? v : '';
};

/** Guest-session calls carry "Authorization: Guest <token>". They must never be replaced by (or log out) a registered session. */
export const isGuestRequest = (config) => authHeaderOf(config).startsWith('Guest ');

/**
 * What a failed request rejects with. Server answered with a JSON object: that body PLUS the HTTP status (so screens can tell a
 * 410 from a 429 without reaching into the axios error). Anything else keeps the previous behaviour (raw data, or the error itself).
 */
export function shapeRejection(error) {
  const data = error?.response?.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) return { ...data, status: error.response.status };
  return data ?? error;
}

/** A 401 signs a REGISTERED user out. A guest session expiring is handled by the guest screens, never by a global logout. */
export const shouldForceLogout = (error) => error?.response?.status === 401 && !isGuestRequest(error?.config);
