// Provider settings editor: onboarding status + declared capabilities (currencies, services, limits). Super Admin only (API enforces).
import React, { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Modal } from '@/components/common';
import api from '@/services/api';
import { ProviderRow, ONBOARDING_LABEL, ONBOARDING_ORDER, SERVICES, errMsg } from './shared';

interface Props { provider: ProviderRow | null; env: string; onClose: () => void; onSaved: () => void }

const ProviderSettingsModal: React.FC<Props> = ({ provider, env, onClose, onSaved }) => {
  const [onboarding, setOnboarding] = useState('PLANNED');
  const [currencies, setCurrencies] = useState('');
  const [services, setServices] = useState<string[]>([]);
  const [minAmount, setMinAmount] = useState('');
  const [maxAmount, setMaxAmount] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!provider) return;
    setOnboarding(provider.onboardingStatus);
    setCurrencies((provider.capabilities?.currencies || []).join(', '));
    setServices(provider.capabilities?.services || []);
    setMinAmount(provider.capabilities?.minAmount != null ? String(provider.capabilities.minAmount) : '');
    setMaxAmount(provider.capabilities?.maxAmount != null ? String(provider.capabilities.maxAmount) : '');
  }, [provider]);

  if (!provider) return null;
  const toggle = (s: string) => setServices(cur => (cur.includes(s) ? cur.filter(x => x !== s) : [...cur, s]));

  const save = async () => {
    const list = currencies.split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
    if (list.some(c => !/^[A-Z]{3}$/.test(c))) { toast.error('Currencies must be 3-letter codes, e.g. NGN'); return; }
    const lo = minAmount === '' ? null : Number(minAmount); const hi = maxAmount === '' ? null : Number(maxAmount);
    if ((lo != null && !(lo >= 0)) || (hi != null && !(hi > 0)) || (lo != null && hi != null && lo > hi)) { toast.error('Check the minimum / maximum amounts'); return; }
    if (env === 'LIVE' && onboarding === 'PRODUCTION_APPROVED' && !confirm('Record written MTN production approval? Only do this once MTN has approved production access in writing.')) return;
    setSaving(true);
    try {
      await api.put(`/admin/payment-providers/${provider.providerKey}/${provider.countryCode}/settings`, {
        environment: env, onboardingStatus: onboarding,
        capabilities: { ...(provider.capabilities || {}), currencies: list, services, minAmount: lo, maxAmount: hi },
      });
      toast.success('Settings saved'); onSaved(); onClose();
    } catch (err) { toast.error(errMsg(err, 'Could not save settings')); } finally { setSaving(false); }
  };

  return (
    <Modal isOpen onClose={onClose} title={`${provider.name} — ${provider.countryCode} settings (${env})`} size="lg"
      footer={<><button className="px-4 py-2 text-sm rounded-xl bg-gray-100" onClick={onClose}>Cancel</button>
        <button disabled={saving} className="px-4 py-2 text-sm rounded-xl bg-gray-900 text-white disabled:opacity-50" onClick={save}>{saving ? 'Saving…' : 'Save settings'}</button></>}>
      <div className="space-y-4 text-sm">
        <label className="block"><span className="text-gray-600">Onboarding status</span>
          <select className="mt-1 w-full border rounded-lg p-2" value={onboarding} onChange={e => setOnboarding(e.target.value)}>
            {ONBOARDING_ORDER.map(k => <option key={k} value={k}>{ONBOARDING_LABEL[k]}</option>)}
          </select>
          <span className="text-xs text-gray-400">LIVE cannot be enabled until this is “Production approved” (written MTN approval).</span>
        </label>
        <label className="block"><span className="text-gray-600">Declared currencies (comma separated)</span>
          <input className="mt-1 w-full border rounded-lg p-2" value={currencies} onChange={e => setCurrencies(e.target.value)} placeholder="NGN" />
          <span className="text-xs text-gray-400">Only currencies MTN confirmed in writing for this market.</span>
        </label>
        <div><span className="text-gray-600">Enabled services</span>
          <div className="mt-1 flex gap-4">{SERVICES.map(s => <label key={s} className="flex items-center gap-2"><input type="checkbox" checked={services.includes(s)} onChange={() => toggle(s)} />{s}</label>)}</div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><span className="text-gray-600">Minimum amount</span><input type="number" min="0" className="mt-1 w-full border rounded-lg p-2" value={minAmount} onChange={e => setMinAmount(e.target.value)} /></label>
          <label className="block"><span className="text-gray-600">Maximum amount</span><input type="number" min="0" className="mt-1 w-full border rounded-lg p-2" value={maxAmount} onChange={e => setMaxAmount(e.target.value)} /></label>
        </div>
        {provider.callbackUrl && <p className="text-xs text-gray-500 break-all">Callback URL pattern (the token is generated per payment): <code>{provider.callbackUrl}</code></p>}
      </div>
    </Modal>
  );
};
export default ProviderSettingsModal;
