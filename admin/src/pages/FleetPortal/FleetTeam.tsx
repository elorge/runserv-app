import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { UserPlus } from 'lucide-react';
import { Badge, Button, Card, Modal } from '@/components/common';
import { fleetPortalAPI } from '@/services/api/fleetPortal';
import { FLEET_ROLE_HELP, FLEET_ROLE_LABEL, FleetRole } from '@/types/fleetPortal';
import { FleetPage, Loading, LoadError, Th, Field, fieldCls, selectCls, apiError, fmtDate, personName, useFleet, useLoad } from './shared';

type Assignable = Exclude<FleetRole, 'OWNER'>;
const ROLES: Assignable[] = ['ADMIN', 'FLEET_MANAGER', 'OPERATIONS', 'FINANCE', 'VIEWER'];

const AddModal: React.FC<{ onClose: () => void; onDone: () => void }> = ({ onClose, onDone }) => {
  const [email, setEmail] = useState(''); const [role, setRole] = useState<Assignable>('VIEWER'); const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try { await fleetPortalAPI.addMember({ email: email.trim(), role }); toast.success('Team member added'); onDone(); }
    catch (e) { toast.error(apiError(e)); } finally { setBusy(false); }
  };
  return (
    <Modal isOpen onClose={onClose} title="Add a team member" size="md"
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!email.includes('@')} onClick={submit}>Add</Button></>}>
      <div className="space-y-3 text-sm">
        <Field label="Their Runserv email" hint="They need a Runserv account first. They sign in here with the same email and password."><input className={fieldCls} type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Role" hint={FLEET_ROLE_HELP[role]}><select className={fieldCls} value={role} onChange={(e) => setRole(e.target.value as Assignable)}>{ROLES.map((r) => <option key={r} value={r}>{FLEET_ROLE_LABEL[r]}</option>)}</select></Field>
      </div>
    </Modal>
  );
};

const FleetTeam: React.FC = () => {
  const { can } = useFleet();
  const [adding, setAdding] = useState(false); const [busy, setBusy] = useState<string | null>(null);
  const { data, error, loading, reload } = useLoad(() => fleetPortalAPI.team(), []);
  if (!can.manageUsers) return <FleetPage title="Team"><p className="text-sm text-gray-500">Only the Owner and Admins can manage the team.</p></FleetPage>;
  const change = async (id: string, body: { role?: Assignable; isActive?: boolean }, ok: string) => {
    setBusy(id);
    try { await fleetPortalAPI.updateMember(id, body); toast.success(ok); reload(); } catch (e) { toast.error(apiError(e)); } finally { setBusy(null); }
  };
  return (
    <FleetPage title="Team" subtitle="Who can sign in to this portal and what they can do."
      actions={<Button onClick={() => setAdding(true)}><UserPlus className="h-4 w-4" /> Add member</Button>}>
      <Card>
        {loading && <Loading />}
        {error && <LoadError message={error} onRetry={reload} />}
        {data && (
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead><tr className="border-b border-gray-100"><Th>Name</Th><Th>Email</Th><Th>Role</Th><Th>Access</Th><Th right /></tr></thead>
            <tbody className="divide-y divide-gray-50">{data.map((m) => (
              <tr key={m.id} className={m.isActive ? '' : 'opacity-60'}>
                <td className="py-3 pr-4 font-medium">{personName(m.user)}</td>
                <td className="py-3 pr-4 text-gray-600">{m.user.email}</td>
                <td className="py-3 pr-4">{m.role === 'OWNER' ? <Badge variant="info">Owner</Badge> : (
                  <select aria-label={`Role for ${m.user.email}`} className={selectCls} value={m.role} disabled={busy === m.id} onChange={(e) => change(m.id, { role: e.target.value as Assignable }, 'Role updated')}>
                    {ROLES.map((r) => <option key={r} value={r}>{FLEET_ROLE_LABEL[r]}</option>)}</select>)}</td>
                <td className="py-3 pr-4">{m.isActive ? <Badge variant="success">Active</Badge> : <Badge>Removed</Badge>}<p className="text-xs text-gray-400">Added {fmtDate(m.invitedAt)}</p></td>
                <td className="py-3 text-right">{m.role !== 'OWNER' && (m.isActive
                  ? <Button size="sm" variant="outline" loading={busy === m.id} onClick={() => window.confirm(`Remove ${m.user.email}’s access to this portal?`) && change(m.id, { isActive: false }, 'Access removed')}>Remove access</Button>
                  : <Button size="sm" variant="outline" loading={busy === m.id} onClick={() => change(m.id, { isActive: true }, 'Access restored')}>Restore</Button>)}</td>
              </tr>))}</tbody></table></div>)}
      </Card>
      <Card><h2 className="text-sm font-semibold text-gray-900 mb-2">What each role can do</h2>
        <ul className="text-sm text-gray-600 space-y-1">{(['OWNER', ...ROLES] as FleetRole[]).map((r) => <li key={r}><b>{FLEET_ROLE_LABEL[r]}:</b> {FLEET_ROLE_HELP[r]}</li>)}</ul></Card>
      {adding && <AddModal onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
    </FleetPage>
  );
};
export default FleetTeam;
