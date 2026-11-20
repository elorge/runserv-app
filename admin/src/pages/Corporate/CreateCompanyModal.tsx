// Onboard an organisation: creates it, its org code and its first organisation admin.
import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { Modal, Button, Input, Alert } from '@/components/common';
import { CopyChip } from '@/pages/Company/ui';
import api from '@/services/api';

const empty = { name: '', email: '', phone: '', address: '', rcNumber: '', commission: '18', slug: '', fFirst: '', fLast: '', fEmail: '', fPhone: '' };

const CreateCompanyModal: React.FC<{ isOpen: boolean; onClose: () => void; onCreated: () => void }> = ({ isOpen, onClose, onCreated }) => {
  const [f, setF] = useState(empty); const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ orgCode: string; email: string; password: string | null; slug: string } | null>(null);
  const set = (k: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const ok = f.name && f.email && f.phone && f.fFirst && f.fLast && f.fEmail;
  const close = () => { setF(empty); setDone(null); onClose(); };
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.post('/admin/corporate/companies', {
        name: f.name, email: f.email, phone: f.phone, address: f.address || undefined, rcNumber: f.rcNumber || undefined, commissionRate: Number(f.commission) / 100, slug: f.slug || undefined,
        admin: { firstName: f.fFirst, lastName: f.fLast, email: f.fEmail, phone: f.fPhone || undefined },
      });
      const x = r.data.data; setDone({ orgCode: x.company.orgCode, email: x.admin.email, password: x.temporaryPassword, slug: x.company.slug }); onCreated();
    } catch (e: any) { toast.error(e?.response?.data?.message || 'Could not create the organisation'); } finally { setBusy(false); }
  };
  return (
    <Modal isOpen={isOpen} onClose={close} title={done ? 'Organisation created' : 'New organisation'} size="lg"
      footer={done ? <Button onClick={close}>Done</Button> : <><Button variant="outline" onClick={close}>Cancel</Button><Button loading={busy} disabled={!ok} onClick={submit}>Create & activate</Button></>}>
      {done ? (
        <div className="space-y-3 text-sm">
          <p>Give staff this organisation code so they can ask to be listed from the app:</p><CopyChip text={done.orgCode} />
          <p className="pt-2">Dashboard sign-in for the organisation admin:</p>
          <div className="rounded-lg bg-gray-50 p-3 space-y-1"><p>Email: <b>{done.email}</b></p>{done.password ? <p>Temporary password: <b className="font-mono">{done.password}</b></p> : <p>They sign in with their existing Runserv password (or Google).</p>}
            {done.slug && <p>Portal: <b>{done.slug}.business.runserv.org</b></p>}</div>
          {done.password && <Alert variant="warning">This password is shown once. Send it securely.</Alert>}
          <Alert variant="info">The organisation starts <b>prepaid</b>. Verify it and agree a credit limit before offering monthly billing.</Alert>
        </div>
      ) : (
        <div className="space-y-4">
          <div><p className="text-xs font-semibold uppercase text-gray-400 mb-2">Organisation</p>
            <div className="grid sm:grid-cols-2 gap-3"><Input label="Name" value={f.name} onChange={set('name')} /><Input label="RC number (optional)" value={f.rcNumber} onChange={set('rcNumber')} />
              <Input label="Email" type="email" value={f.email} onChange={set('email')} /><Input label="Phone" value={f.phone} onChange={set('phone')} />
              <Input label="Address" value={f.address} onChange={set('address')} /><Input label="Runserv commission (%)" type="number" value={f.commission} onChange={set('commission')} />
              <Input label="Portal address (optional)" value={f.slug} onChange={set('slug')} placeholder="acme → acme.business.runserv.org" /></div></div>
          <div><p className="text-xs font-semibold uppercase text-gray-400 mb-2">Organisation admin (first dashboard user)</p>
            <div className="grid sm:grid-cols-2 gap-3"><Input label="First name" value={f.fFirst} onChange={set('fFirst')} /><Input label="Last name" value={f.fLast} onChange={set('fLast')} />
              <Input label="Email" type="email" value={f.fEmail} onChange={set('fEmail')} /><Input label="Phone (optional)" value={f.fPhone} onChange={set('fPhone')} /></div></div>
        </div>)}
    </Modal>
  );
};
export default CreateCompanyModal;
