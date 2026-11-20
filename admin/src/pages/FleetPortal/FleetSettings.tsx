import React, { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Button } from '@/components/common';
import { fleetPortalAPI } from '@/services/api/fleetPortal';
import { FleetPage, Loading, LoadError, InfoCard, Field, StatusBadge, fieldCls, apiError, pct, useFleet, useLoad } from './shared';

const FleetSettings: React.FC = () => {
  const { can } = useFleet();
  const { data, error, loading, reload } = useLoad(() => fleetPortalAPI.profile(), []);
  const f = data?.fleetPartner;
  const [form, setForm] = useState({ tradingName: '', email: '', phone: '', address: '', supportEmail: '', payoutAccountName: '', payoutBankCode: '', payoutAccountNumber: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (f) setForm({ tradingName: f.tradingName ?? '', email: f.email ?? '', phone: f.phone ?? '', address: f.address ?? '', supportEmail: f.supportEmail ?? '', payoutAccountName: f.payoutAccountName ?? '', payoutBankCode: f.payoutBankCode ?? '', payoutAccountNumber: f.payoutAccountNumber ?? '' }); }, [f]);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const accountOk = !form.payoutAccountNumber || /^\d{10}$/.test(form.payoutAccountNumber);
  if (!can.manageSettings) return <FleetPage title="Settings"><p className="text-sm text-gray-500">Only the Owner and Admins can change fleet settings.</p></FleetPage>;
  const save = async () => {
    setBusy(true);
    try {
      const body: Record<string, string> = {};
      for (const [k, v] of Object.entries(form)) if (v !== '' || (f as any)?.[k]) body[k] = v;
      await fleetPortalAPI.updateProfile(body); toast.success('Settings saved'); reload();
    } catch (e) { toast.error(apiError(e)); } finally { setBusy(false); }
  };
  return (
    <FleetPage title="Settings" subtitle="Your fleet’s contact and payout details.">
      {loading && <Loading />}
      {error && <LoadError message={error} onRetry={reload} />}
      {f && (
        <>
          <InfoCard title="Your account with Runserv">
            <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div><dt className="text-xs text-gray-500">Registered name</dt><dd className="font-medium">{f.legalName}</dd></div>
              <div><dt className="text-xs text-gray-500">RC number</dt><dd className="font-medium">{f.rcNumber ?? '—'}</dd></div>
              <div><dt className="text-xs text-gray-500">Account</dt><dd><StatusBadge status={f.status} /></dd></div>
              <div><dt className="text-xs text-gray-500">Verification</dt><dd><StatusBadge status={f.verificationStatus} /></dd></div>
              {f.commissionRate !== undefined && <div><dt className="text-xs text-gray-500">Runserv fee (per agreement)</dt><dd className="font-medium">{pct(f.commissionRate)}</dd></div>}
              {f.settlementTermsDays !== undefined && <div><dt className="text-xs text-gray-500">Settlement terms</dt><dd className="font-medium">{f.settlementTermsDays} days</dd></div>}
            </dl>
            <p className="text-xs text-gray-400 mt-3">Legal name, RC number, fee and settlement terms are set by Runserv under your signed agreement. Contact support to change them.</p>
          </InfoCard>
          <InfoCard title="Contact details">
            <div className="grid md:grid-cols-2 gap-3">
              <Field label="Trading name"><input className={fieldCls} value={form.tradingName} onChange={set('tradingName')} /></Field>
              <Field label="Business email"><input className={fieldCls} type="email" value={form.email} onChange={set('email')} /></Field>
              <Field label="Phone"><input className={fieldCls} value={form.phone} onChange={set('phone')} /></Field>
              <Field label="Support email (shown to your drivers)"><input className={fieldCls} type="email" value={form.supportEmail} onChange={set('supportEmail')} /></Field>
              <div className="md:col-span-2"><Field label="Address"><input className={fieldCls} value={form.address} onChange={set('address')} /></Field></div>
            </div>
          </InfoCard>
          <InfoCard title="Payout account">
            <div className="grid md:grid-cols-3 gap-3">
              <Field label="Account name"><input className={fieldCls} value={form.payoutAccountName} onChange={set('payoutAccountName')} /></Field>
              <Field label="Bank code"><input className={fieldCls} value={form.payoutBankCode} onChange={set('payoutBankCode')} maxLength={10} /></Field>
              <Field label="Account number" hint={accountOk ? '10 digits' : undefined}><input className={fieldCls} inputMode="numeric" value={form.payoutAccountNumber} onChange={set('payoutAccountNumber')} maxLength={10} />
                {!accountOk && <span className="block text-xs text-red-600 mt-1">Account number must be 10 digits</span>}</Field>
            </div>
            <p className="text-xs text-gray-400 mt-3">Changes to payout details are recorded in the audit log. Runserv pays settlements to this account.</p>
          </InfoCard>
          <div><Button loading={busy} disabled={!accountOk} onClick={save}>Save changes</Button></div>
        </>)}
    </FleetPage>
  );
};
export default FleetSettings;
