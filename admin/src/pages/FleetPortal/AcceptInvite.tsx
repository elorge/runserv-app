// /fleet/accept-invite?token=… — the invitee signs in (an account with the invited email), then accepts. Stands alone: the invitee has no fleet yet.
import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Button } from '@/components/common';
import { useAuthStore } from '@/store/authStore';
import { fleetPortalAPI, apiError } from '@/services/api/fleetPortal';

export const INVITE_KEY = 'fleetInviteToken';
const keep = (t: string | null) => { try { if (t) sessionStorage.setItem(INVITE_KEY, t); else return sessionStorage.getItem(INVITE_KEY); } catch { /* storage blocked */ } return t; };

const AcceptInvite: React.FC = () => {
  const [params] = useSearchParams(); const navigate = useNavigate();
  const { isAuthenticated, user, setUser } = useAuthStore();
  const [token] = useState(() => params.get('token') || keep(null));
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => { if (params.get('token')) keep(params.get('token')); }, [params]);

  const accept = async () => {
    if (!token) return; setBusy(true); setError('');
    try {
      await fleetPortalAPI.acceptInvitation(token);
      try { sessionStorage.removeItem(INVITE_KEY); } catch { /* ignore */ }
      const x = await fleetPortalAPI.profile();
      if (x?.fleetPartner && user) setUser({ ...user, fleet: { id: x.fleetPartner.id, name: x.fleetPartner.tradingName || x.fleetPartner.legalName, status: x.fleetPartner.status, verificationStatus: x.fleetPartner.verificationStatus, role: x.role, permissions: x.permissions } });
      toast.success('You have joined the fleet'); navigate('/', { replace: true });
    } catch (e) { setError(apiError(e)); } finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-xl shadow-sm border border-gray-100 p-6 space-y-4">
        <h1 className="text-lg font-semibold text-gray-900">Join a fleet on Runserv</h1>
        {!token && <p className="text-sm text-red-600">This link is missing its invitation code. Open the link from your invitation email again.</p>}
        {token && !isAuthenticated && <>
          <p className="text-sm text-gray-600">Sign in with the email address the invitation was sent to, then come back to this page to accept. You need a Runserv account first; if you do not have one, create it in the Runserv app using that email.</p>
          <Link to="/login"><Button className="w-full">Sign in</Button></Link></>}
        {token && isAuthenticated && <>
          <p className="text-sm text-gray-600">Signed in as <b>{user?.email}</b>. Accepting adds you to the fleet’s team with the role in the invitation.</p>
          {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
          <Button className="w-full" loading={busy} onClick={accept}>Accept invitation</Button></>}
      </div>
    </div>
  );
};
export default AcceptInvite;
