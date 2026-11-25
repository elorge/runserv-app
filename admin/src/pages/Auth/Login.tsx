// admin-web/src/pages/Auth/Login.tsx
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/store/authStore';
import { authAPI } from '@/services/api/auth';
import api from '@/services/api';
import { Input, Button, Alert } from '@/components/common';
import toast from 'react-hot-toast';
import logo from '@/assets/images/runserv.png';
import { useBrandStore } from '@/store/brandStore';
import GoogleSignIn from './GoogleSignIn';
import LanguageSwitcher from '@/components/LanguageSwitcher';
import MfaStep from './MfaStep';

const ENABLE_FLEET = import.meta.env.VITE_ENABLE_FLEET !== 'false'; // mirrors backend ENABLE_FLEET

const Login: React.FC = () => {
  const navigate = useNavigate();
  const { login } = useAuthStore();
  const [formData, setFormData] = useState({ email: '', password: '' });
  const [loading, setLoading]   = useState(false);
  const [error,   setError]     = useState('');
  const [showPassword, setShowPassword] = useState(false); // toggle password visibility
  const brand = useBrandStore((s) => s.brand);
  // Staff only: set after the password step while the authenticator code is still to be entered.
  const [mfa, setMfa] = useState<{ user: any; token: string; enrolled: boolean } | null>(null);

  /** Shared by password and Google sign-in: Runserv staff go to the admin panel; a person with an organisation role goes to that organisation's dashboard. */
  const finish = async (u: any, token: string) => {
    if (u.role === 'DRIVER' || u.role === 'DELIVERY_PARTNER') { setError('You do not have access to this dashboard'); return; }
    if (u.role === 'CUSTOMER') {
      const prof = await api.get('/corporate/profile', { headers: { Authorization: `Bearer ${token}` }, validateStatus: (s) => s < 500 });
      const d = prof.data?.data;
      if (d?.company) {
        login({ ...u, company: { id: d.company.id, name: d.company.brandName || d.company.name, orgCode: d.company.orgCode, status: d.company.status, memberRole: d.member.role, permissions: d.permissions } }, token);
        toast.success('Welcome back'); navigate('/'); return;
      }
      // Not an organisation user: is this person on a Fleet Partner account? (403 means no.)
      const fp = await api.get('/fleet/profile', { headers: { Authorization: `Bearer ${token}` }, validateStatus: (s) => s < 500 });
      const fd = fp.status === 200 ? fp.data?.data : null;
      if (fd?.fleetPartner) {
        login({ ...u, fleet: { id: fd.fleetPartner.id, name: fd.fleetPartner.tradingName || fd.fleetPartner.legalName, status: fd.fleetPartner.status, verificationStatus: fd.fleetPartner.verificationStatus, role: fd.role, permissions: fd.permissions } }, token);
        toast.success('Welcome back'); navigate('/'); return;
      }
      let invited = false; try { invited = !!sessionStorage.getItem('fleetInviteToken'); } catch { /* ignore */ }
      if (invited) { login(u, token); navigate('/fleet/accept-invite'); return; }   // a fleet invitation is waiting: let them in only to accept it
      setError('This account has no organisation or fleet dashboard access. Ask your organisation admin to give you a role, or apply for a fleet partner account below.'); return;
    }
    login(u, token);
    toast.success('Welcome back'); navigate('/');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await authAPI.login(formData.email, formData.password);

      if (response.mfaRequired) { setMfa({ user: response.data.user, token: response.data.token, enrolled: !!response.mfaEnrolled }); return; }
      // finish() shows the welcome toast and navigates only when sign-in is allowed; a refusal keeps the error on screen.
      await finish(response.data.user, response.data.token);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Invalid credentials');
      toast.error('Login failed');
    } finally {
      setLoading(false);
    }
  };

  // Accessible toggle for screen readers
  const togglePasswordVisibility = () => {
    setShowPassword(!showPassword);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center p-4">
      {/* Background pattern */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-primary-900/20 via-transparent to-transparent pointer-events-none" />

      <div className="max-w-md w-full relative">
        {/* Card */}
        <div className="bg-white rounded-2xl shadow-2xl overflow-hidden">
          {/* Top accent bar */}
          <div className="h-1.5 bg-gradient-to-r from-primary-500 via-primary-400 to-blue-500" />

          <div className="p-8">
            <div className="flex justify-end -mt-3 mb-2"><LanguageSwitcher /></div>
            {/* Logo + branding */}
            <div className="text-center mb-8">
              <div className="flex items-center justify-center mx-auto mb-4">
                <img src={brand.logoUrl || logo} alt={brand.name} className="h-16 w-auto max-w-[220px] object-contain" />
              </div>
              <h2 className="text-2xl font-bold text-gray-900">{brand.name}</h2>
              <p className="text-gray-500 mt-1.5 text-sm">{brand.tagline || 'Sign in to continue'}</p>
            </div>

            {/* Error alert */}
            {error && (
              <Alert variant="error" className="mb-6">
                {error}
              </Alert>
            )}

            {mfa ? (
              <MfaStep token={mfa.token} enrolled={mfa.enrolled} onCancel={() => setMfa(null)} onDone={async (t) => { try { await finish(mfa.user, t); } finally { setMfa(null); } }} />
            ) : (<>
            {/* Form */}
            <form onSubmit={handleSubmit} className="space-y-5">
              <Input
                label="Email"
                type="email"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                placeholder="you@company.com"
                required
              />

              {/* Password field with visibility toggle */}
              <div className="space-y-1">
                <label htmlFor="password" className="block text-sm font-medium text-gray-700">
                  Password
                </label>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    value={formData.password}
                    onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                    placeholder="••••••••"
                    required
                    className="block w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 text-sm pr-10"
                  />
                  <button
                    type="button"
                    onClick={togglePasswordVisibility}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute inset-y-0 right-0 flex items-center pr-3 text-gray-400 hover:text-gray-600 transition-colors"
                  >
                    {showPassword ? (
                      // Eye-off icon (hidden password)
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="h-5 w-5"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                      >
                        <path
                          fillRule="evenodd"
                          d="M3.707 2.293a1 1 0 00-1.414 1.414l14 14a1 1 0 001.414-1.414l-1.473-1.473A10.014 10.014 0 0019.542 10C18.268 5.943 14.478 3 10 3a9.958 9.958 0 00-4.512 1.074l-1.78-1.781zm4.261 4.26l1.514 1.515a2.003 2.003 0 012.45 2.45l1.514 1.514a4 4 0 00-5.478-5.478z"
                          clipRule="evenodd"
                        />
                        <path d="M12.454 16.697L9.75 13.992a4 4 0 01-3.742-3.741L2.335 6.578A9.98 9.98 0 00.458 10c1.274 4.057 5.065 7 9.542 7 .847 0 1.669-.105 2.454-.303z" />
                      </svg>
                    ) : (
                      // Eye icon (show password)
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="h-5 w-5"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                      >
                        <path d="M10 12a2 2 0 100-4 2 2 0 000 4z" />
                        <path
                          fillRule="evenodd"
                          d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z"
                          clipRule="evenodd"
                        />
                      </svg>
                    )}
                  </button>
                </div>
              </div>

              <Button
                type="submit"
                loading={loading}
                className="w-full"
              >
                Sign In
              </Button>
            </form>

            <GoogleSignIn onCredential={async (idToken) => {
              setError(''); setLoading(true);
              try { const r: any = await authAPI.google(idToken); if (r.mfaRequired) { setMfa({ user: r.data.user, token: r.data.token, enrolled: !!r.mfaEnrolled }); return; } await finish(r.data.user, r.data.token); }
              catch (e: any) { setError(e?.response?.data?.message || 'Google sign-in failed'); }
              finally { setLoading(false); }
            }} />

            </>)}

            {ENABLE_FLEET && (
              <p className="mt-6 text-center text-sm text-gray-500">Own a fleet of cars, motorcycles or vans?{' '}
                <button type="button" onClick={() => navigate('/fleet/apply')} className="text-primary-600 hover:text-primary-700 font-medium">Apply for a fleet partner account</button></p>
            )}

            {/* Forgot password */}
            <div className="mt-6 text-center">
              <button
                onClick={() => navigate('/forgot-password')}
                className="text-sm text-primary-600 hover:text-primary-700 font-medium transition-colors"
              >
                Forgot password?
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="text-center mt-5 text-sm text-slate-400">
          © 2026 Runserv. All rights reserved.
          <div className="mt-1 text-xs">Powered by Elorge Technologies Limited</div>
        </div>
      </div>
    </div>
  );
};

export default Login;