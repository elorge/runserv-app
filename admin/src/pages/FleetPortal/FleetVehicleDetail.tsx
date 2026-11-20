import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ArrowLeft, ExternalLink, Pencil, Upload } from 'lucide-react';
import { Badge, Button, Modal } from '@/components/common';
import { fleetPortalAPI } from '@/services/api/fleetPortal';
import { DOCUMENT_TYPES, FleetDocument, PortalVehicle } from '@/types/fleetPortal';
import { FleetPage, Loading, LoadError, StatusBadge, ComplianceChips, InfoCard, Field, fieldCls, apiError, fmtDate, label, useFleet, useLoad } from './shared';
import { SecureDocLink } from '@/components/common/SecureDocLink';

const HELP: Record<string, string> = {
  PENDING: 'Waiting for Runserv to review this vehicle. It cannot take jobs until it is approved.',
  ACTIVE: 'Approved. It can take jobs while its mandatory documents stay valid.',
  SUSPENDED: 'Suspended by Runserv. It cannot take jobs. Contact support.',
  MAINTENANCE: 'In maintenance. It cannot take jobs until Runserv returns it to service.',
  RETIRED: 'Retired from the fleet.',
};
const ymd = (v?: string | null) => (v ? v.slice(0, 10) : '');

const docBadge = (d: FleetDocument) => d.isApproved ? <Badge variant="success">Approved</Badge> : d.rejectionNote ? <Badge variant="error">Rejected</Badge> : <Badge variant="warning">Awaiting review</Badge>;

const EditDatesModal: React.FC<{ v: PortalVehicle; open: boolean; onClose: () => void; onDone: (sentForReview: boolean) => void }> = ({ v, open, onClose, onDone }) => {
  const [f, setF] = useState({ insuranceExpiresAt: ymd(v.insuranceExpiresAt), roadworthyExpiresAt: ymd(v.roadworthyExpiresAt), permitExpiresAt: ymd(v.permitExpiresAt) });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { const r = await fleetPortalAPI.updateVehicle(v.id, { insuranceExpiresAt: f.insuranceExpiresAt || null, roadworthyExpiresAt: f.roadworthyExpiresAt || null, permitExpiresAt: f.permitExpiresAt || null }); onDone(r.sentForReview); }
    catch (e) { toast.error(apiError(e)); } finally { setBusy(false); }
  };
  return (
    <Modal isOpen={open} onClose={onClose} title={`Document dates · ${v.registrationNumber}`} size="md"
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={save}>Save dates</Button></>}>
      <div className="space-y-3 text-sm">
        <Field label="Insurance expires"><input className={fieldCls} type="date" value={f.insuranceExpiresAt} onChange={(e) => setF({ ...f, insuranceExpiresAt: e.target.value })} /></Field>
        <Field label="Roadworthiness expires"><input className={fieldCls} type="date" value={f.roadworthyExpiresAt} onChange={(e) => setF({ ...f, roadworthyExpiresAt: e.target.value })} /></Field>
        <Field label="Permit expires"><input className={fieldCls} type="date" value={f.permitExpiresAt} onChange={(e) => setF({ ...f, permitExpiresAt: e.target.value })} /></Field>
        {v.status === 'ACTIVE' && <p className="rounded-lg bg-amber-50 border border-amber-200 text-amber-900 px-3 py-2 text-xs">Changing a date on an approved vehicle sends it back to Runserv for review. It cannot take new jobs until it is approved again.</p>}
      </div>
    </Modal>
  );
};

const UploadDocModal: React.FC<{ v: PortalVehicle; open: boolean; onClose: () => void; onDone: () => void }> = ({ v, open, onClose, onDone }) => {
  const [type, setType] = useState('insurance'); const [num, setNum] = useState(''); const [issued, setIssued] = useState(''); const [expires, setExpires] = useState('');
  const [file, setFile] = useState<File | null>(null); const [record, setRecord] = useState(true); const [busy, setBusy] = useState(false);
  const field = DOCUMENT_TYPES.find((t) => t.value === type)?.vehicleField;
  const submit = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const up = await fleetPortalAPI.uploadFile(file);
      await fleetPortalAPI.addDocument({ vehicleId: v.id, documentType: type, fileUrl: up.url, documentNumber: num || undefined, issuedAt: issued || undefined, expiresAt: expires || undefined });
      if (field && expires && record) await fleetPortalAPI.updateVehicle(v.id, { [field]: expires });
      toast.success('Document uploaded. Runserv will review it.'); setNum(''); setIssued(''); setExpires(''); setFile(null); onDone();
    } catch (e) { toast.error(apiError(e)); } finally { setBusy(false); }
  };
  return (
    <Modal isOpen={open} onClose={onClose} title={`Upload a document · ${v.registrationNumber}`} size="md"
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!file} onClick={submit}>Upload</Button></>}>
      <div className="space-y-3 text-sm">
        <Field label="Document type"><select className={fieldCls} value={type} onChange={(e) => setType(e.target.value)}>{DOCUMENT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></Field>
        <Field label="File" hint="JPEG, PNG or PDF, up to 5 MB."><input data-testid="doc-file" className={fieldCls} type="file" accept=".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
        <Field label="Document number (optional)"><input className={fieldCls} value={num} onChange={(e) => setNum(e.target.value)} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Issued"><input className={fieldCls} type="date" value={issued} onChange={(e) => setIssued(e.target.value)} /></Field>
          <Field label="Expires"><input className={fieldCls} type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></Field>
        </div>
        {field && expires && (
          <label className="flex items-start gap-2 text-xs text-gray-600"><input type="checkbox" className="mt-0.5" checked={record} onChange={(e) => setRecord(e.target.checked)} />
            <span>Also record this expiry date on the vehicle. The job-eligibility check uses the date saved on the vehicle{v.status === 'ACTIVE' ? ', and changing it sends an approved vehicle back to Runserv for review' : ''}.</span></label>)}
      </div>
    </Modal>
  );
};

const FleetVehicleDetail: React.FC = () => {
  const { id = '' } = useParams();
  const { can } = useFleet();
  const [editing, setEditing] = useState(false); const [uploading, setUploading] = useState(false);
  const { data, error, loading, reload } = useLoad(() => Promise.all([fleetPortalAPI.vehicle(id), fleetPortalAPI.documents(id)]), [id]);
  const v = data?.[0].vehicle; const compliance = data?.[0].compliance; const docs = data?.[1] ?? [];
  const asVehicle = v ? ({ ...v, compliance: compliance! } as PortalVehicle) : null;
  return (
    <FleetPage title={v ? `${v.registrationNumber} · ${v.make} ${v.model}` : 'Vehicle'}
      actions={<Link to="/fleet/vehicles" className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"><ArrowLeft className="h-4 w-4" /> All vehicles</Link>}>
      {loading && <Loading />}
      {error && <LoadError message={error} onRetry={reload} />}
      {v && asVehicle && compliance && (
        <>
          <InfoCard title="Status">
            <div className="flex flex-wrap items-center gap-3"><StatusBadge status={v.status} /><span className="text-sm text-gray-600">{HELP[v.status]}</span></div>
            <p className="text-xs text-gray-400 mt-2">Only Runserv can approve, suspend or retire a vehicle.</p>
          </InfoCard>
          <InfoCard title="What blocks this vehicle from jobs">
            {compliance.blockers.length ? (
              <ul className="list-disc pl-5 text-sm text-red-700 space-y-1" data-testid="vehicle-blockers">{compliance.blockers.map((b) => <li key={b}>Mandatory document: {b}</li>)}</ul>
            ) : <p className="text-sm text-emerald-700">No expired or missing mandatory document.</p>}
            {compliance.warnings.length > 0 && <ul className="list-disc pl-5 text-sm text-amber-700 space-y-1 mt-2">{compliance.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
            <div className="mt-3"><ComplianceChips c={compliance} /></div>
            {can.manageVehicles && <Button className="mt-3" size="sm" variant="outline" onClick={() => setEditing(true)}><Pencil className="h-3.5 w-3.5" /> Edit document dates</Button>}
          </InfoCard>
          <InfoCard title="Details">
            <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              {([['Type', label(v.vehicleType)], ['Year', v.modelYear ?? '—'], ['Colour', v.colour ?? '—'], ['Seats', v.seatingCapacity ?? '—'],
                ['Insurance expires', fmtDate(v.insuranceExpiresAt)], ['Roadworthiness expires', fmtDate(v.roadworthyExpiresAt)], ['Permit expires', fmtDate(v.permitExpiresAt)]] as [string, React.ReactNode][]).map(([k, val]) => (
                <div key={k}><dt className="text-xs text-gray-500">{k}</dt><dd className="font-medium text-gray-900">{val}</dd></div>))}
            </dl>
          </InfoCard>
          <InfoCard title="Documents">
            {can.manageDocuments && <Button className="mb-3" size="sm" onClick={() => setUploading(true)}><Upload className="h-3.5 w-3.5" /> Upload a document</Button>}
            {!docs.length ? <p className="text-sm text-gray-400">No documents uploaded yet.</p> : (
              <ul className="divide-y divide-gray-100" data-testid="doc-list">
                {docs.map((d) => (
                  <li key={d.id} className="py-2.5 flex flex-wrap items-center justify-between gap-2 text-sm">
                    <div><p className="font-medium text-gray-900">{label(d.documentType)}{d.documentNumber ? ` · ${d.documentNumber}` : ''}</p>
                      <p className="text-xs text-gray-400">Uploaded {fmtDate(d.createdAt)} · Expires {fmtDate(d.expiresAt)}</p>
                      {d.rejectionNote && <p className="text-xs text-red-600 mt-0.5">Runserv: {d.rejectionNote}</p>}</div>
                    <div className="flex items-center gap-3">{docBadge(d)}<SecureDocLink access={{ source: 'FLEET_DOCUMENT', id: d.id, field: 'fileUrl' }} className="text-primary-700 hover:underline inline-flex items-center gap-1 text-xs">Open <ExternalLink className="h-3 w-3" /></SecureDocLink></div>
                  </li>))}
              </ul>)}
          </InfoCard>
          {editing && <EditDatesModal v={asVehicle} open onClose={() => setEditing(false)} onDone={(review) => { setEditing(false); toast.success(review ? 'Saved. This vehicle has been sent back to Runserv for review.' : 'Saved.'); reload(); }} />}
          {uploading && <UploadDocModal v={asVehicle} open onClose={() => setUploading(false)} onDone={() => { setUploading(false); reload(); }} />}
        </>
      )}
    </FleetPage>
  );
};
export default FleetVehicleDetail;
