// Append-only evidence trail for one payment (state changes, webhooks, verifications, admin decisions).
import React, { useEffect, useState } from 'react';
import { Modal, Spinner } from '@/components/common';
import api from '@/services/api';
import { PaymentEventRow } from './shared';

const PaymentTimelineModal: React.FC<{ paymentId: string | null; onClose: () => void }> = ({ paymentId, onClose }) => {
  const [events, setEvents] = useState<PaymentEventRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!paymentId) return;
    setEvents(null); setFailed(false);
    api.get(`/admin/payment-ops/payments/${paymentId}/events`).then(r => setEvents(r.data.data.events)).catch(() => setFailed(true));
  }, [paymentId]);
  if (!paymentId) return null;
  return (
    <Modal isOpen onClose={onClose} title="Payment event timeline" size="xl">
      {failed ? <p className="text-sm text-red-600">Could not load events.</p>
        : events === null ? <div className="py-6 flex justify-center"><Spinner /></div>
        : events.length === 0 ? <p className="text-sm text-gray-400">No events recorded.</p>
        : <ol className="space-y-3 text-sm max-h-[60vh] overflow-y-auto">
            {events.map(e => (
              <li key={e.id} className="border-l-2 border-gray-200 pl-3">
                <div className="flex flex-wrap items-center gap-2">
                  <b>{e.eventType.replace(/_/g, ' ')}</b>
                  {e.fromStatus || e.toStatus ? <span className="text-gray-600">{e.fromStatus || '—'} → {e.toStatus || '—'}</span> : null}
                  {e.outcome && <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100">{e.outcome}</span>}
                  <span className="text-xs text-gray-400">source: {e.source} · verification: {e.verification}</span>
                </div>
                <div className="text-xs text-gray-400">{new Date(e.createdAt).toLocaleString()}</div>
                {e.meta ? <pre className="mt-1 text-xs bg-gray-50 rounded p-2 overflow-x-auto">{JSON.stringify(e.meta, null, 2)}</pre> : null}
              </li>))}
          </ol>}
    </Modal>
  );
};
export default PaymentTimelineModal;
