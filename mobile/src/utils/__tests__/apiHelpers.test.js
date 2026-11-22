import { isGuestRequest, shapeRejection, shouldForceLogout } from '../../services/apiHelpers';
import { quoteErrorMessage } from '../guestPlanner';

const cfg = (auth) => ({ headers: { Authorization: auth } });
const axiosHeaders = (auth) => ({ headers: { get: (k) => (k === 'Authorization' ? auth : undefined) } });

describe('guest requests are told apart from registered ones', () => {
  test('plain and AxiosHeaders-style configs', () => {
    expect(isGuestRequest(cfg('Guest abc'))).toBe(true);
    expect(isGuestRequest(axiosHeaders('Guest abc'))).toBe(true);
    expect(isGuestRequest(cfg('Bearer abc'))).toBe(false);
    expect(isGuestRequest({})).toBe(false);
    expect(isGuestRequest(undefined)).toBe(false);
  });
  test('a 401 logs a registered user out but never reacts to a guest session ending', () => {
    expect(shouldForceLogout({ response: { status: 401 }, config: cfg('Bearer t') })).toBe(true);
    expect(shouldForceLogout({ response: { status: 401 }, config: cfg('Guest t') })).toBe(false);
    expect(shouldForceLogout({ response: { status: 400 }, config: cfg('Bearer t') })).toBe(false);
    expect(shouldForceLogout({ config: cfg('Bearer t') })).toBe(false);
  });
});

describe('shapeRejection', () => {
  test('server JSON body gets the HTTP status added', () => {
    expect(shapeRejection({ response: { status: 410, data: { success: false, message: 'm', code: 'QUOTE_EXPIRED' } } })).toEqual({ success: false, message: 'm', code: 'QUOTE_EXPIRED', status: 410 });
  });
  test('non-object bodies and offline errors keep the previous behaviour', () => {
    expect(shapeRejection({ response: { status: 502, data: '<html>bad gateway</html>' } })).toBe('<html>bad gateway</html>');
    const offline = new Error('Network Error');
    expect(shapeRejection(offline)).toBe(offline);
  });
});

describe('planner quote errors now reflect the real server answer', () => {
  test('route, disabled, rate limit, offline and generic', () => {
    expect(quoteErrorMessage({ status: 503, code: 'ROUTE_UNAVAILABLE' })).toMatch(/route/);
    expect(quoteErrorMessage({ status: 404 })).toMatch(/not available/);
    expect(quoteErrorMessage({ status: 429 })).toMatch(/Too many/);
    expect(quoteErrorMessage(new Error('Network Error'))).toMatch(/No connection/);
    expect(quoteErrorMessage({ status: 500, message: 'x' })).toMatch(/Could not get an estimate/);
    expect(quoteErrorMessage({ response: { status: 429, data: {} } })).toMatch(/Too many/); // raw axios shape still understood
  });
});
