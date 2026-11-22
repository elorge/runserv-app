// Credential entry / rotation. Values are write-only: never prefilled, never shown back, cleared on close.
import React, { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Modal } from '@/components/common';
import api from '@/services/api';
import { ProviderRow, SECRET_LABEL, errMsg } from './shared';

interface Props { provider: ProviderRow | null; env: string; onClose: () => void; onSaved: () => void }

const CredentialsModal: React.FC<Props> = ({ provider, env, onClose, onSaved }) => {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => { setValues({}); }, [provider]);
  if (!provider) return null;

  const names = Object.keys(provider.credentials);
  const close = () => { setValues({}); onClose(); };
  const filled = Object.entries(values).filter(([, v]) => v.length > 0);

  const save = async () => {
    if (!filled.length) { toast.error('Enter at least one value'); return; }
    if (!confirm(`Replace ${filled.length} credential(s) for ${provider.name} (${env})? The old value(s) stop working here immediately.`)) return;
    setSaving(true);
    try {
      await api.put(`/admin/payment-providers/${provider.providerKey}/${provider.countryCode}/secrets`, { environment: env, values: Object.fromEntries(filled) });
      toast.success('Credentials saved (encrypted)'); setValues({}); onSaved(); onClose();
    } catch (err) { toast.error(errMsg(err, 'Could not save credentials')); } finally { setSaving(false); }
  };

  return (
    <Modal isOpen onClose={close} title={`${provider.name} credentials (${env})`} size="lg"
      footer={<><button className="px-4 py-2 text-sm rounded-xl bg-gray-100" onClick={close}>Cancel</button>
        <button disabled={saving || !provider.secretEntryAvailable} className="px-4 py-2 text-sm rounded-xl bg-gray-900 text-white disabled:opacity-50" onClick={save}>{saving ? 'Saving…' : 'Save credentials'}</button></>}>
      {!provider.secretEntryAvailable ? (
        <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">Secret entry is switched off because <b>PAYMENT_SECRETS_KEY</b> is not set on the backend. Set these credentials as backend environment variables instead.</p>
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-gray-500">Values are encrypted on the server and can never be viewed again — only replaced. Leave a field empty to keep its current value.</p>
          {names.map(n => (
            <label key={n} className="block">
              <span className="text-gray-600">{SECRET_LABEL[n] || n} <span className={provider.credentials[n] ? 'text-green-700' : 'text-gray-400'}>({provider.credentials[n] ? 'currently set' : 'missing'})</span></span>
              <input type="password" autoComplete="new-password" className="mt-1 w-full border rounded-lg p-2 font-mono" value={values[n] || ''}
                onChange={e => setValues(v => ({ ...v, [n]: e.target.value }))} placeholder="••••••••" />
            </label>))}
          {provider.secretsRotatedAt && <p className="text-xs text-gray-400">Last rotated {new Date(provider.secretsRotatedAt).toLocaleString()}</p>}
        </div>
      )}
    </Modal>
  );
};
export default CredentialsModal;
