import api from './index';
import { ApiResponse, User } from '@/types';

export const authAPI = {
  login: async (email: string, password: string): Promise<ApiResponse<{ user: User; token: string }> & { mfaRequired?: boolean; mfaEnrolled?: boolean }> => {
    const response = await api.post('/auth/login', { email, password });
    return response.data;
  },

  /** Sign in with a Google ID token (Google Identity Services). */
  google: async (idToken: string): Promise<ApiResponse<{ user: User; token: string }>> => {
    const response = await api.post('/auth/google', { idToken });
    return response.data;
  },

  /** Staff two-step sign-in. Every call uses the limited token from the password step, passed explicitly. */
  mfaSetup: async (token: string): Promise<{ secret: string; otpauthUrl: string }> =>
    (await api.post('/auth/mfa/setup', {}, { headers: { Authorization: `Bearer ${token}` } })).data.data,
  mfaEnable: async (token: string, code: string): Promise<{ token: string; backupCodes: string[] }> =>
    (await api.post('/auth/mfa/enable', { code }, { headers: { Authorization: `Bearer ${token}` } })).data.data,
  mfaVerify: async (token: string, input: { code?: string; backupCode?: string }): Promise<{ token: string; via: 'app' | 'backup'; backupCodesLeft?: number }> =>
    (await api.post('/auth/mfa/verify', input, { headers: { Authorization: `Bearer ${token}` } })).data.data,
  mfaDisable: async (code: string): Promise<void> => { await api.post('/auth/mfa/disable', { code }); },

  getCurrentUser: async (): Promise<ApiResponse<{ user: User }>> => {
    const response = await api.get('/auth/me');
    return response.data;
  },

  logout: async (): Promise<void> => {
    // Implement if backend has logout endpoint
    await api.post('/auth/logout');
  },

  forgotPassword: async (email: string): Promise<ApiResponse<void>> => {
    const response = await api.post('/auth/forgot-password', { email });
    return response.data;
  },
};