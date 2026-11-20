// Public screen: a Runserv customer applies for a Fleet Partner account.
// The person signs in with their existing Runserv account; the token is held in this component only
// (nothing is stored as a signed-in portal session until the application is submitted).
import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Alert, Button, Input } from '@/components/common';
import { authAPI } from '@/services/api/auth';
import { fleetPortalAPI, apiError } from '@/services/api/fleetPortal';
import { useAuthStore } from '@/store/authStore';
import logo from '@/assets/images/runserv.png';

const FleetApply: React.FC = () => {
  const navigate = useNavigate();
  const { login } = useAuthStore();
  const [session, setSession] = useState<{ user: any; token: string } | null>(null);
  const [cred, setCred] = useState({ email: '', password: '' });
  const [f, setF] = useState({ legalName: '', tradingName: '', rcNumber: '', taxId: '', email: '', phone: '', address: '' });
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const signIn = async (e: React.FormEvent) => {
    e.preventDefault(); setError(''); setBusy(true);
    try {
      const r = await authAPI.login(cred.email, cred.password);
      if (r.data.user.role !== 'CUSTOMER') { setError('Please apply with a customer account. Drivers and Runserv staff cannot open a fleet account with their current role.'); return; }
      setSession({ user: r.data.user, token: r.data.token });
      setF((x) => ({ ...x, email: r.data.user.email ?? '', phone: r.data.user.phone ?? '' }));
    } catch (err: any) { setError(apiError(err, 'Invalid credentials')); } finally { setBusy(false); }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); if (!session) return; setError(''); setBusy(true);
    try {
      const body: Record<string, string> = {};
      for (const [k, v] of Object.entries(f)) if (v.trim()) body[k] = v.trim();
      await fleetPortalAPI.apply(body as any, session.token);
      const p = await fleetPortalAPI.profile(session.token);
      login({ ...session.user, fleet: { id: p.fleetPartner.id, name: p.fleetPartner.tradingName || p.fleetPartner.legalName, status: p.fleetPartner.status, verificationStatus: p.fleetPartner.verificationStatus, role: p.role, permissions: p.permissions } }, session.token);
      toast.success('Application sent. Runserv will review it.'); navigate('/');
    } catch (err: any) { setError(apiError(err, 'Could not send your application')); } finally { setBusy(false); }
  };

  const ok = f.legalName.trim() && f.email.includes('@') && f.phone.trim();
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center p-4">
      <div className="max-w-lg w-full">
        <div className="bg-white rounded-2xl shadow-2xl overflow-hidden">
          <div className="h-1.5 bg-gradient-to-r from-primary-500 via-primary-400 to-blue-500" />
          <div className="p-8">
            <div className="text-center mb-6"><img src={logo} alt="Runserv" className="h-14 w-auto mx-auto mb-3" /><h1 className="text-2xl font-bold text-gray-900">Apply for a fleet partner account</h1>
              <p className="text-sm text-gray-500 mt-1">Run cars, motorcycles or vans on Runserv with your own drivers.</p></div>
            {error && <Alert variant="error" className="mb-4">{error}</Alert>}
            {!session ? (
              <form onSubmit={signIn} className="space-y-4" data-testid="apply-signin">
                <p className="text-sm text-gray-600">Sign in with your Runserv account. New to Runserv? Create an account in the Runserv app first, then come back here.</p>
                <Input label="Email" type="email" value={cred.email} onChange={(e) => setCred({ ...cred, email: e.target.value })} required />
                <Input label="Password" type="password" value={cred.password} onChange={(e) => setCred({ ...cred, password: e.target.value })} required />
                <Button type="submit" loading={busy} className="w-full">Continue</Button>
              </form>
            ) : (
              <form onSubmit={submit} className="space-y-4" data-testid="apply-form">
                <Input label="Registered business name" value={f.legalName} onChange={set('legalName')} required />
                <Input label="Trading name (optional)" value={f.tradingName} onChange={set('tradingName')} />
                <div className="grid grid-cols-2 gap-3">
                  <Input label="RC number (CAC)" value={f.rcNumber} onChange={set('rcNumber')} />
                  <Input label="Tax ID (TIN)" value={f.taxId} onChange={set('taxId')} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Input label="Business email" type="email" value={f.email} onChange={set('email')} required />
                  <Input label="Phone" value={f.phone} onChange={set('phone')} required />
                </div>
                <Input label="Business address" value={f.address} onChange={set('address')} />
                <p className="text-xs text-gray-500">You become the owner of the account. Runserv reviews your business, then you add vehicles and documents, and drivers who are already approved on Runserv. No vehicle takes jobs until Runserv approves it.</p>
                <Button type="submit" loading={busy} disabled={!ok} className="w-full">Send application</Button>
              </form>)}
            <p className="text-center mt-6 text-sm"><Link to="/login" className="text-primary-600 hover:text-primary-700 font-medium">Back to sign in</Link></p>
          </div>
        </div>
      </div>
    </div>
  );
};
export default FleetApply;
