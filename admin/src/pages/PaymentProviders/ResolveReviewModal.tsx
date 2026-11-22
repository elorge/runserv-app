// Manual resolution of a REVIEW_REQUIRED payment. Super Admin only; the evidence note is mandatory and audited.
import React, { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Modal } from '@/components/common';
import api from '@/services/api';
import { errMsg } from './shared';

const ResolveReviewModal: React.FC<{ paymentId: string | null; onClose: () => void; onDone: () => void }> = ({ paymentId, onClose, onDone }) => {
  const [outcome, setOutcome] = useState<'COMPLETE' | 'FAIL'>('FAIL');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { setOutcome('FAIL'); setNote(''); }, [paymentId]);
  if (!paymentId) return null;
  const submit = async () => {
    if (note.trim().length < 10) { toast.error('Explain the evidence in at least 10 characters'); return; }
    if (outcome === 'COMPLETE' && !confirm('Mark this payment as PAID? Only do this if you have confirmed the money in the MTN statement/portal.')) return;
    setSaving(true);
    try { await api.post(`/admin/payment-ops/payments/${paymentId}/resolve`, { outcome, note: note.trim() }); toast.success('Payment resolved'); onDone(); onClose(); }
    catch (err) { toast.error(errMsg(err, 'Could not resolve payment')); } finally { setSaving(false); }
  };
  return (
    <Modal isOpen onClose={onClose} title="Resolve payment needing review" size="lg"
      footer={<><button className="px-4 py-2 text-sm rounded-xl bg-gray-100" onClick={onClose}>Cancel</button>
        <button disabled={saving} className="px-4 py-2 text-sm rounded-xl bg-gray-900 text-white disabled:opacity-50" onClick={submit}>{saving ? 'Saving…' : 'Confirm decision'}</button></>}>
      <div className="space-y-4 text-sm">
        <p className="text-gray-500">This payment was held because the provider’s report did not match what Runserv expected. Review the event timeline and the MTN statement before deciding.</p>
        <div className="space-y-2">
          <label className="flex items-start gap-2"><input type="radio" checked={outcome === 'FAIL'} onChange={() => setOutcome('FAIL')} /><span><b>Mark as failed</b> — no money was received.</span></label>
          <label className="flex items-start gap-2"><input type="radio" checked={outcome === 'COMPLETE'} onChange={() => setOutcome('COMPLETE')} /><span><b>Mark as paid</b> — the full amount is confirmed received.</span></label>
        </div>
        <label className="block"><span className="text-gray-600">Evidence note (required, min 10 characters)</span>
          <textarea className="mt-1 w-full border rounded-lg p-2" rows={3} maxLength={300} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. MTN statement 20 Nov line 142 shows the full amount received" /></label>
      </div>
    </Modal>
  );
};
export default ResolveReviewModal;
