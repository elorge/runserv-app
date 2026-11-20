import React, { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Card, Button, Input, Spinner } from '@/components/common';
import { useBrandStore } from '@/store/brandStore';
import { applyBrandColor } from '@/utils/brand';
import { companyAPI, errMsg } from '@/services/api/company';
import type { CompanyProfile, WeekendPolicy } from '@/types/company';
import { PageHeader, CopyChip } from './ui';

const POLICIES: { value: WeekendPolicy; label: string; help: string }[] = [
  { value: 'APPROVAL_REQUIRED', label: 'Weekend rides need approval', help: 'Staff ask for a specific Saturday or Sunday; a manager, HR or admin approves it. (Recommended)' },
  { value: 'OPEN_SATURDAY', label: 'Saturday open, Sunday needs approval', help: 'Saturdays work like weekdays; Sundays need a request.' },
  { value: 'OPEN_WEEKEND', label: 'Saturday and Sunday open', help: 'Weekends work like weekdays.' },
  { value: 'CLOSED', label: 'No weekend rides on the company account', help: 'Staff can still pay for weekend rides themselves.' },
];

const SettingsPage: React.FC = () => {
  const [c, setC] = useState<CompanyProfile | null>(null);
  const [rules, setRules] = useState({ maxTripAmount: '', approvalThreshold: '' });
  const [brand, setBrand] = useState({ brandName: '', brandColor: '#1D4ED8', logoUrl: '', tagline: '', supportEmail: '' });
  const [details, setDetails] = useState({ phone: '', address: '', billingEmail: '' });
  const [busy, setBusy] = useState(''); const setBrandStore = useBrandStore((s) => s.set);

  useEffect(() => { companyAPI.profile().then((p) => { const x = p.company; setC(x);
    setRules({ maxTripAmount: x.maxTripAmount?.toString() ?? '', approvalThreshold: x.approvalThreshold?.toString() ?? '' });
    setBrand({ brandName: x.brandName ?? '', brandColor: x.brandColor ?? '#1D4ED8', logoUrl: x.logoUrl ?? '', tagline: x.tagline ?? '', supportEmail: x.supportEmail ?? '' });
    setDetails({ phone: x.phone, address: x.address ?? '', billingEmail: x.billingEmail ?? '' }); }).catch((e) => toast.error(errMsg(e))); }, []);
  if (!c) return <div className="py-24 flex justify-center"><Spinner size="lg" /></div>;

  const saveSettings = async (patch: Record<string, unknown>, key = 's') => {
    setBusy(key);
    try { const r = await companyAPI.updateSettings(patch); setC({ ...c, ...r.company }); toast.success('Saved'); } catch (e) { toast.error(errMsg(e)); } finally { setBusy(''); }
  };
  const saveBrand = async () => {
    setBusy('b');
    try { const r = await companyAPI.updateBranding({ ...brand, logoUrl: brand.logoUrl || null }); setC({ ...c, ...r.company });
      setBrandStore({ name: brand.brandName || c.name, logoUrl: brand.logoUrl || null, color: brand.brandColor, tagline: brand.tagline || null, supportEmail: brand.supportEmail || null }); toast.success('Branding saved'); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(''); }
  };

  return (
    <div className="max-w-3xl">
      <PageHeader title="Settings" />
      <Card className="mb-4">
        <h3 className="font-semibold text-gray-900">Your organisation code</h3>
        <p className="text-sm text-gray-500 mt-1 mb-3">Staff open the Runserv app → <b>Profile → My organisation</b>, enter this code and their <b>staff ID</b>. HR checks the request against your staff directory and approves it.</p>
        <CopyChip text={c.orgCode} />
      </Card>

      <Card className="mb-4">
        <h3 className="font-semibold text-gray-900 mb-1">Trip rules</h3>
        <p className="text-sm text-gray-500 mb-3">Departments can override these on the Departments page.</p>
        <div className="grid sm:grid-cols-2 gap-3">
          <Input label={`Maximum cost of one trip (${c.currency}) — blank for none`} type="number" min={0} value={rules.maxTripAmount} onChange={(e) => setRules({ ...rules, maxTripAmount: e.target.value })} />
          <Input label={`Manager approval needed above (${c.currency}) — blank for never`} type="number" min={0} value={rules.approvalThreshold} onChange={(e) => setRules({ ...rules, approvalThreshold: e.target.value })} />
        </div>
        <div className="mt-3 flex justify-end"><Button loading={busy === 'r'} onClick={() => saveSettings({ maxTripAmount: rules.maxTripAmount, approvalThreshold: rules.approvalThreshold }, 'r')}>Save rules</Button></div>
        <label className="flex items-start gap-3 py-2 mt-2"><input type="checkbox" className="mt-1" checked={c.requireTripPurpose} onChange={(e) => saveSettings({ requireTripPurpose: e.target.checked })} />
          <span><span className="block text-sm font-medium">Staff must say why they are travelling</span><span className="block text-xs text-gray-500">Shown in your audit (e.g. “Client visit — Zenith Bank, VI”).</span></span></label>
        <label className="flex items-start gap-3 py-2"><input type="checkbox" className="mt-1" checked={c.allowDeliveries} onChange={(e) => saveSettings({ allowDeliveries: e.target.checked })} />
          <span><span className="block text-sm font-medium">Allow Runserv deliveries on the company account</span><span className="block text-xs text-gray-500">Use Runserv riders instead of your own dispatch rider.</span></span></label>
      </Card>

      <Card className="mb-4">
        <h3 className="font-semibold text-gray-900 mb-3">Weekend rides</h3>
        <div className="space-y-2">{POLICIES.map((p) => (
          <label key={p.value} className={`flex gap-3 p-3 rounded-lg border cursor-pointer ${c.weekendPolicy === p.value ? 'border-primary-500 bg-primary-50/40' : 'border-gray-200 hover:bg-gray-50'}`}>
            <input type="radio" className="mt-1" checked={c.weekendPolicy === p.value} onChange={() => saveSettings({ weekendPolicy: p.value })} disabled={busy === 's'} />
            <span><span className="block text-sm font-medium text-gray-900">{p.label}</span><span className="block text-xs text-gray-500">{p.help}</span></span></label>))}</div>
        <p className="text-xs text-gray-400 mt-2">Monday to Friday always work. Times follow {c.timezone}.</p>
      </Card>

      <Card className="mb-4">
        <h3 className="font-semibold text-gray-900">Your brand</h3>
        <p className="text-sm text-gray-500 mt-1 mb-3">Your dashboard, sign-in page and installable app use your name, logo and colour. Runserv sets your portal address.</p>
        <div className="grid sm:grid-cols-2 gap-3">
          <Input label="Display name" value={brand.brandName} placeholder={c.name} onChange={(e) => setBrand({ ...brand, brandName: e.target.value })} />
          <Input label="Tagline" value={brand.tagline} onChange={(e) => setBrand({ ...brand, tagline: e.target.value })} />
          <Input label="Logo link (https, PNG/SVG)" value={brand.logoUrl} onChange={(e) => setBrand({ ...brand, logoUrl: e.target.value })} />
          <Input label="Support email" type="email" value={brand.supportEmail} onChange={(e) => setBrand({ ...brand, supportEmail: e.target.value })} />
          <label className="block"><span className="block text-sm font-medium text-gray-700 mb-1">Brand colour</span>
            <div className="flex items-center gap-2"><input type="color" value={brand.brandColor} onChange={(e) => { setBrand({ ...brand, brandColor: e.target.value }); applyBrandColor(e.target.value); }} className="h-10 w-14 rounded border border-gray-300" />
              <span className="font-mono text-sm text-gray-600">{brand.brandColor}</span></div></label>
        </div>
        {brand.logoUrl && <img src={brand.logoUrl} alt="Logo preview" className="h-12 mt-3 object-contain" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />}
        <div className="mt-4 flex justify-end"><Button loading={busy === 'b'} onClick={saveBrand}>Save branding</Button></div>
      </Card>

      <Card>
        <h3 className="font-semibold text-gray-900 mb-3">Company details</h3>
        <div className="grid sm:grid-cols-2 gap-3">
          <Input label="Phone" value={details.phone} onChange={(e) => setDetails({ ...details, phone: e.target.value })} />
          <Input label="Address" value={details.address} onChange={(e) => setDetails({ ...details, address: e.target.value })} />
          <Input label="Billing email (invoices)" type="email" value={details.billingEmail} onChange={(e) => setDetails({ ...details, billingEmail: e.target.value })} />
        </div>
        <div className="mt-4 flex items-center justify-between"><p className="text-xs text-gray-400">Billing arrangement, credit limit and commission are managed with Runserv.</p><Button loading={busy === 'p'} onClick={() => saveSettings(details, 'p')}>Save</Button></div>
      </Card>
    </div>
  );
};
export default SettingsPage;
