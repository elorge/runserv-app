// Runserv staff: one organisation — approve, verify, set billing mode / credit / commission, fund the wallet.
import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import toast from 'react-hot-toast';
import { Card, Badge, Spinner, Button, Input } from '@/components/common';
import { CopyChip } from '@/pages/Company/ui';
import api from '@/services/api';
import { formatMoney } from '@/utils/money';

const msg = (e: any) => e?.response?.data?.message || 'Something went wrong';
const st = (s: string) => (s === 'ACTIVE' || s === 'VERIFIED' || s === 'PAID' ? 'success' : s === 'SUSPENDED' || s === 'REJECTED' || s === 'OVERDUE' ? 'error' : 'warning') as 'success' | 'error' | 'warning';
const sel = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white';

const CompanyDetails: React.FC = () => {
  const { id } = useParams(); const navigate = useNavigate();
  const [data, setData] = useState<any>(null); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState('');
  const [t, setT] = useState<any>({}); const [v, setV] = useState({ status: 'UNVERIFIED', notes: '' }); const [w, setW] = useState({ amount: '', reference: '', note: '' }); const [dom, setDom] = useState({ slug: '', customDomain: '' });

  const load = useCallback(() => {
    api.get(`/admin/corporate/companies/${id}`).then((r) => {
      const x = r.data.data; setData(x); const c = x.company;
      setT({ billingMode: c.billingMode, creditLimit: String(c.creditLimit ?? 0), creditTermsSigned: !!c.creditTermsSignedAt, commission: String(Math.round(c.commissionRate * 1000) / 10), subscriptionFee: String(c.subscriptionFee ?? 0), paymentTermsDays: String(c.paymentTermsDays), lowBalanceThreshold: String(c.lowBalanceThreshold ?? 0) });
      setV({ status: c.verificationStatus, notes: c.verificationNotes ?? '' }); setDom({ slug: c.slug ?? '', customDomain: c.customDomain ?? '' });
    }).catch((e) => toast.error(msg(e))).finally(() => setLoading(false));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const run = async (key: string, fn: () => Promise<any>, ok: string) => { setBusy(key); try { await fn(); toast.success(ok); load(); } catch (e) { toast.error(msg(e)); } finally { setBusy(''); } };

  if (loading) return <div className="py-24 flex justify-center"><Spinner size="lg" /></div>;
  if (!data) return null;
  const c = data.company; const s = data.stats; const f = data.funding; const money = (n: number) => formatMoney(n, c.currency);
  const creditReady = c.verificationStatus === 'VERIFIED';

  return (
    <div className="space-y-5">
      <button onClick={() => navigate('/corporate')} className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900"><ArrowLeft className="h-4 w-4" />Organisations</button>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="text-2xl font-bold text-gray-900">{c.name}</h1><p className="text-sm text-gray-500">{c.email} · {c.phone} · Admin: {c.owner.firstName} {c.owner.lastName} ({c.owner.email})</p>
          <div className="flex items-center gap-2 mt-2"><Badge variant={st(c.status)}>{c.status}</Badge><Badge variant={st(c.verificationStatus)}>{c.verificationStatus.replace('_', ' ')}</Badge><CopyChip text={c.orgCode} /></div></div>
        <div className="flex gap-2">
          {c.status !== 'ACTIVE' && <Button variant="success" loading={busy === 'st'} onClick={() => run('st', () => api.put(`/admin/corporate/companies/${id}/status`, { status: 'ACTIVE' }), 'Organisation approved')}>Approve & activate</Button>}
          {c.status === 'ACTIVE' && <Button variant="danger" loading={busy === 'st'} onClick={() => window.confirm('Suspend this organisation? Staff cannot book on the company until reactivated.') && run('st', () => api.put(`/admin/corporate/companies/${id}/status`, { status: 'SUSPENDED' }), 'Suspended')}>Suspend</Button>}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {[['Listed staff', s.staff], ['Awaiting HR', s.pending], ['Departments', s.departments], ['Trips completed', s.trips], ['Billed to date', money(s.billed)]].map(([l, x]) => (
          <div key={l as string} className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm"><p className="text-xs text-gray-500">{l}</p><p className="text-xl font-bold mt-1">{x}</p></div>))}
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        <Card>
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">Verification</h3>
          <p className="text-xs text-gray-500 mb-3">Check the company's registration documents and business before offering monthly billing. Un-verifying moves it back to prepaid.</p>
          <select className={sel} value={v.status} onChange={(e) => setV({ ...v, status: e.target.value })}>{['UNVERIFIED', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED'].map((x) => <option key={x} value={x}>{x.replace('_', ' ')}</option>)}</select>
          <textarea className={`${sel} mt-2`} rows={3} placeholder="Notes (documents seen, references, director checks…)" value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} />
          <Button className="mt-3" loading={busy === 'v'} onClick={() => run('v', () => api.put(`/admin/corporate/companies/${id}/verification`, v), 'Verification saved')}>Save verification</Button>
        </Card>

        <Card>
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">Billing arrangement</h3>
          <label className="block mb-2"><span className="block text-xs text-gray-500 mb-1">Billing mode</span>
            <select className={sel} value={t.billingMode} onChange={(e) => setT({ ...t, billingMode: e.target.value })}>
              <option value="PREPAID">Prepaid wallet (default)</option><option value="POSTPAID" disabled={!creditReady}>Monthly invoice (postpaid){creditReady ? '' : ' — verify first'}</option><option value="HYBRID" disabled={!creditReady}>Hybrid: wallet + credit{creditReady ? '' : ' — verify first'}</option></select></label>
          {t.billingMode !== 'PREPAID' && (<div className="space-y-2 mb-2">
            <Input label="Agreed credit limit" type="number" min={0} value={t.creditLimit} onChange={(e) => setT({ ...t, creditLimit: e.target.value })} />
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={t.creditTermsSigned} onChange={(e) => setT({ ...t, creditTermsSigned: e.target.checked })} />Signed payment terms received {c.creditTermsSignedAt && <span className="text-xs text-gray-400">({new Date(c.creditTermsSignedAt).toLocaleDateString('en-GB')})</span>}</label></div>)}
          <div className="grid grid-cols-2 gap-2">
            <Input label="Runserv commission (%)" type="number" min={0} max={60} step={0.5} value={t.commission} onChange={(e) => setT({ ...t, commission: e.target.value })} />
            <Input label="Monthly subscription" type="number" min={0} value={t.subscriptionFee} onChange={(e) => setT({ ...t, subscriptionFee: e.target.value })} />
            <Input label="Payment terms (days)" type="number" min={0} max={90} value={t.paymentTermsDays} onChange={(e) => setT({ ...t, paymentTermsDays: e.target.value })} />
            <Input label="Low-balance alert at" type="number" min={0} value={t.lowBalanceThreshold} onChange={(e) => setT({ ...t, lowBalanceThreshold: e.target.value })} /></div>
          <p className="text-xs text-gray-400 mt-1">Driver receives {(100 - Number(t.commission || 0)).toFixed(1)}% of each fare.</p>
          <Button className="mt-3" loading={busy === 't'} onClick={() => run('t', () => api.put(`/admin/corporate/companies/${id}/terms`, { billingMode: t.billingMode, creditLimit: Number(t.creditLimit), creditTermsSigned: t.creditTermsSigned, commissionRate: Number(t.commission) / 100, subscriptionFee: Number(t.subscriptionFee), paymentTermsDays: Number(t.paymentTermsDays), lowBalanceThreshold: Number(t.lowBalanceThreshold) }), 'Terms saved')}>Save terms</Button>
        </Card>

        <Card>
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">Wallet &amp; credit</h3>
          <div className="grid grid-cols-3 gap-2 mb-3 text-sm">
            <div className="bg-gray-50 rounded-lg p-3"><p className="text-xs text-gray-500">Balance</p><p className="font-bold">{money(c.walletBalance)}</p></div>
            <div className="bg-gray-50 rounded-lg p-3"><p className="text-xs text-gray-500">Credit used</p><p className="font-bold">{money(f.creditExposure)}</p></div>
            <div className="bg-gray-50 rounded-lg p-3"><p className="text-xs text-gray-500">Credit left</p><p className="font-bold">{money(f.creditAvailable)}</p></div></div>
          <p className="text-xs text-gray-500 mb-2">Received a bank transfer? Credit the wallet here (card top-ups credit automatically).</p>
          <div className="grid grid-cols-2 gap-2"><Input label="Amount" type="number" min={1} value={w.amount} onChange={(e) => setW({ ...w, amount: e.target.value })} /><Input label="Bank reference" value={w.reference} onChange={(e) => setW({ ...w, reference: e.target.value })} /></div>
          <Button className="mt-2" disabled={!(Number(w.amount) > 0)} loading={busy === 'w'} onClick={() => run('w', async () => { await api.post(`/admin/corporate/companies/${id}/wallet/credit`, { amount: Number(w.amount), reference: w.reference || undefined }); setW({ amount: '', reference: '', note: '' }); }, 'Wallet credited')}>Credit wallet</Button>
          {data.walletTransactions.length > 0 && <ul className="mt-3 text-xs divide-y divide-gray-100 max-h-40 overflow-y-auto">{data.walletTransactions.map((x: any) => <li key={x.id} className="py-1.5 flex justify-between"><span className="text-gray-500 truncate pr-2">{x.description}</span><b className={x.amount < 0 ? '' : 'text-emerald-600'}>{x.amount > 0 ? '+' : ''}{money(x.amount)}</b></li>)}</ul>}
        </Card>

        <Card>
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">White-label portal address</h3>
          <p className="text-xs text-gray-500 mb-2">The organisation’s dashboard opens at <b>{dom.slug || 'name'}.business.runserv.org</b>, or on its own domain (add a CNAME to the portal host first).</p>
          <div className="grid grid-cols-2 gap-2"><Input label="Subdomain" value={dom.slug} onChange={(e) => setDom({ ...dom, slug: e.target.value.toLowerCase() })} /><Input label="Custom domain" value={dom.customDomain} onChange={(e) => setDom({ ...dom, customDomain: e.target.value.toLowerCase() })} placeholder="rides.acme.com" /></div>
          <Button className="mt-3" loading={busy === 'd'} onClick={() => run('d', () => api.put(`/admin/corporate/companies/${id}/domain`, { slug: dom.slug || null, customDomain: dom.customDomain || null }), 'Address saved')}>Save address</Button>
        </Card>
      </div>

      <Card>
        <div className="flex items-center justify-between mb-3"><h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Recent invoices</h3><Link to={`/corporate/invoices?companyId=${id}`} className="text-sm text-primary-600 hover:underline">All invoices →</Link></div>
        {data.invoices.length === 0 ? <p className="text-sm text-gray-400">None yet.</p> : (
          <table className="w-full text-sm"><tbody className="divide-y divide-gray-50">{data.invoices.map((i: any) => (
            <tr key={i.id}><td className="py-2 font-mono text-xs">{i.invoiceNumber}</td><td>{i.period}</td><td className="text-right font-semibold">{money(i.subtotal)}</td><td className="text-right text-gray-500">{money(i.amountPaid)} paid</td><td className="text-right"><Badge variant={st(i.status)}>{i.status.replace('_', ' ')}</Badge></td></tr>))}</tbody></table>)}
      </Card>
    </div>
  );
};
export default CompanyDetails;
