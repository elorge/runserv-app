// Read-only audit trail of provider/payment-ops changes (names and outcomes only — secrets never enter audit rows).
import React, { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Card } from '@/components/common';
import api from '@/services/api';

interface Entry { id: string; createdAt: string; action: string; userId: string | null; entityType: string; entityId: string | null; details: unknown }

const AuditTab: React.FC = () => {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { api.get('/admin/payment-ops/audit').then(r => setEntries(r.data.data.entries)).catch(() => toast.error('Failed to load audit log')).finally(() => setLoading(false)); }, []);
  return (
    <Card padding={false}>
      <table className="w-full text-sm">
        <thead><tr className="text-left text-gray-500 border-b"><th className="p-3">When</th><th>Action</th><th>Actor</th><th>Entity</th><th>Details</th></tr></thead>
        <tbody>
          {entries.map(e => (
            <tr key={e.id} className="border-b last:border-0 align-top">
              <td className="p-3 whitespace-nowrap">{new Date(e.createdAt).toLocaleString()}</td>
              <td>{e.action.replace(/_/g, ' ')}</td>
              <td className="font-mono text-xs">{e.userId ? e.userId.slice(0, 8) : '—'}</td>
              <td className="text-xs">{e.entityType}{e.entityId ? ` · ${e.entityId.slice(0, 8)}` : ''}</td>
              <td className="text-xs text-gray-500 max-w-md break-words">{e.details ? JSON.stringify(e.details) : ''}</td>
            </tr>))}
          {!loading && entries.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-gray-400">No audit entries yet.</td></tr>}
        </tbody>
      </table>
    </Card>
  );
};
export default AuditTab;
