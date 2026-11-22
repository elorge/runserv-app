// mobile/src/utils/apiError.js — one place that understands how API failures reach a screen.
//
// services/api.js rejects with the response BODY (plus `status`, added by the interceptor) when the server answered, or with the
// raw axios error when it did not (offline, timeout). So `err.response` is normally undefined on a server error: read these fields
// through parseApiError instead of reaching into the error.
//
// Returns { status, code, attemptsLeft, message, network }:
//   network      true when no HTTP answer arrived (offline / timeout / DNS)
//   code         the server's machine code (e.g. QUOTE_EXPIRED) when it sent one
//   attemptsLeft wrong-code attempts left (POD / OTP) when the server sent it
//   message      the server's own message, only when it answered
export function parseApiError(err) {
  const status = Number(err?.status ?? err?.response?.status) || null;
  const body = err?.response?.data && typeof err.response.data === 'object' ? err.response.data : err;
  const code = status && typeof body?.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(body.code) ? body.code : null;
  const attemptsLeft = status && Number.isFinite(body?.attemptsLeft) ? body.attemptsLeft : null;
  const message = status && typeof body?.message === 'string' && body.message.trim() ? body.message.trim() : null;
  return { status, code, attemptsLeft, message, network: !status };
}

/** A server's message is only shown to people when it is a client error (4xx): 5xx text is generic or technical. */
export const safeServerMessage = (p) => (p.message && p.status && p.status < 500 ? p.message : null);
