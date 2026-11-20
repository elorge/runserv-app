// Runserv staff: monthly company invoices, collection and driver settlement.
import React, { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Receipt, Play } from 'lucide-react';
import { Card, Button, Modal, Input, Badge, Spinner, Pagination } from '@/components/common';
import api from '@/services/api';
import { formatMoney } from '@/utils/money';

const tone = (s: string) => (s === 'PAID' ? 'success' : s === 'OVERDUE' ? 'error' : s === 'VOID' ? 'default' : 'warning') as any;
const left = (i: any) => Math.max(0, Math.round((i.subtotal - i.amountPaid) * 100) / 100);
const d = (s?: string | null) => (s ? new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const msg = (e: any) => e?.response?.data?.message || 'Something went wrong';

const Invoices: React.FC = () => {
  const [sp] = useSearchParams();
  const companyId = sp.get('companyId') || undefined;
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<any[]>([]); const [pages, setPages] = useState(1);
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState<any>(null);          // invoice detail
  const [pay, setPay] = useState<any>(null);          // mark-paid dialog
  const [ref, setRef] = useState(''); const [amt, setAmt] = useState(''); const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([api.get('/admin/corporate/invoices', { params: { status: status || undefined, companyId, page, limit: 20 } }), api.get('/admin/corporate/stats')])
      .then(([r, s]) => { setRows(r.data.data.invoices); setPages(r.data.data.pagination.pages); setStats(s.data.data); }).catch((e) => toast.error(msg(e))).finally(() => setLoading(false));
  }, [status, companyId, page]);
  useEffect(() => { load(); }, [load]);

  const runBilling = async () => {
    setBusy(true);
    try { const r = await api.post('/admin/corporate/invoices/generate', {}); toast.success(r.data.message); load(); } catch (e) { toast.error(msg(e)); } finally { setBusy(false); }
  };
  const open = async (id: string) => { try { setSel((await api.get(`/admin/corporate/invoices/${id}`)).data.data); } catch (e) { toast.error(msg(e)); } };
  const markPaid = async () => {
    setBusy(true);
    try { const r = await api.post(`/admin/corporate/invoices/${pay.id}/payments`, { amount: Number(amt), reference: ref || undefined, method: 'BANK_TRANSFER' });
      const out = r.data.data; toast.success(out.fullyPaid ? `Fully paid — ${out.settlement?.paid ?? 0} driver payout(s) credited` : 'Part payment recorded'); setPay(null); setRef(''); setSel(null); load(); }
    catch (e) { toast.error(msg(e)); } finally { setBusy(false); }
  };
  const settle = async (inv: any, advance = false) => {
    if (advance && !window.confirm('Pay drivers now, before the company has paid? Runserv carries the risk until the invoice is collected.')) return;
    try { const r = await api.post(`/admin/corporate/invoices/${inv.id}/settle-drivers`, { advance }); toast.success(r.data.message); open(inv.id); load(); } catch (e) { toast.error(msg(e)); }
  };
  const voidIt = async (inv: any) => {
    if (!window.confirm('Void this invoice and release its trips so they can be billed again?')) return;
    try { await api.put(`/admin/corporate/invoices/${inv.id}/void`); toast.success('Invoice voided'); setSel(null); load(); } catch (e) { toast.error(msg(e)); }
  };

  const Stat = ({ l, v, s }: { l: string; v: React.ReactNode; s?: string }) => (
    <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm"><p className="text-xs text-gray-500">{l}</p><p className="text-xl font-bold mt-1">{v}</p>{s && <p className="text-xs text-gray-400 mt-0.5">{s}</p>}</div>);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3"><div className="w-10 h-10 bg-blue-100 rounded-xl flex items-center justify-center"><Receipt className="h-5 w-5 text-blue-600" /></div>
          <div><h1 className="text-2xl font-bold text-gray-900">Company invoices</h1><p className="text-sm text-gray-500">Issued monthly on the 1st (01:00 Lagos). Drivers are paid the rest when the invoice is paid in full.</p></div></div>
        <Button loading={busy} variant="outline" onClick={runBilling}><Play className="h-4 w-4 inline mr-1.5" />Run billing now</Button>
      </div>

      {stats && <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat l="Billed this month" v={formatMoney(stats.monthToDate.billed, 'NGN')} s={`${stats.monthToDate.trips} trips`} />
        <Stat l="Runserv revenue (MTD)" v={formatMoney(stats.monthToDate.runservRevenue, 'NGN')} />
        <Stat l="Outstanding invoices" v={formatMoney(stats.outstandingInvoices.amount, 'NGN')} s={`${stats.outstandingInvoices.count} open · ${stats.overdueInvoices} overdue`} />
        <Stat l="Owed to drivers" v={formatMoney(stats.owedToDrivers, 'NGN')} s="accrued, not yet paid out" /></div>}

      <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
        <option value="">All statuses</option><option value="ISSUED">Issued</option><option value="PARTIALLY_PAID">Part paid</option><option value="OVERDUE">Overdue</option><option value="PAID">Paid</option><option value="VOID">Void</option></select>

      <Card>
        {loading ? <div className="py-16 flex justify-center"><Spinner /></div> : rows.length === 0 ? <p className="text-center text-gray-400 py-12">No invoices yet.</p> : (
          <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-gray-100 text-left text-xs uppercase text-gray-500">
            <th className="pb-3 pr-4">Invoice</th><th className="pb-3 pr-4">Company</th><th className="pb-3 pr-4 text-right">Trips</th><th className="pb-3 pr-4 text-right">Amount</th><th className="pb-3 pr-4 text-right">Outstanding</th><th className="pb-3 pr-4">Due</th><th className="pb-3">Status</th></tr></thead>
            <tbody className="divide-y divide-gray-50">{rows.map((i) => (
              <tr key={i.id} onClick={() => open(i.id)} className="cursor-pointer hover:bg-gray-50">
                <td className="py-3 pr-4 font-mono text-xs">{i.invoiceNumber}</td><td className="py-3 pr-4 font-medium">{i.company?.name}</td>
                <td className="py-3 pr-4 text-right">{i.tripCount}</td><td className="py-3 pr-4 text-right font-semibold">{formatMoney(i.subtotal, i.currency)}</td>
                <td className="py-3 pr-4 text-right text-gray-500">{left(i) > 0 ? formatMoney(left(i), i.currency) : '—'}</td><td className="py-3 pr-4">{d(i.dueDate)}</td>
                <td className="py-3"><Badge variant={tone(i.status)}>{i.status.replace('_', ' ')}</Badge></td></tr>))}</tbody></table></div>)}
      </Card>
      <Pagination currentPage={page} totalPages={pages} onPageChange={setPage} />

      <Modal isOpen={!!sel} onClose={() => setSel(null)} size="xl" title={sel ? `${sel.invoice.invoiceNumber} — ${sel.invoice.company.name}` : ''}
        footer={sel && <>
          {sel.invoice.status !== 'PAID' && sel.invoice.status !== 'VOID' && <Button variant="danger" onClick={() => voidIt(sel.invoice)}>Void</Button>}
          {sel.invoice.status !== 'PAID' && sel.invoice.status !== 'VOID' && <Button variant="outline" onClick={() => settle(sel.invoice, true)}>Pay drivers in advance</Button>}
          {sel.invoice.status === 'PAID' && !sel.invoice.driversSettledAt && <Button onClick={() => settle(sel.invoice)}>Retry driver payouts</Button>}
          {sel.invoice.status !== 'PAID' && sel.invoice.status !== 'VOID' && <Button variant="success" onClick={() => { setPay(sel.invoice); setRef(''); setAmt(String(left(sel.invoice))); }}>Record payment</Button>}</>}>
        {sel && (() => { const i = sel.invoice; return (
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-gray-50 rounded-lg p-3"><p className="text-xs text-gray-500">Company owes</p><p className="text-lg font-bold">{formatMoney(i.subtotal, i.currency)}</p><p className="text-[11px] text-gray-400">{formatMoney(i.tripsAmount, i.currency)} trips{i.subscriptionAmount > 0 ? ` + ${formatMoney(i.subscriptionAmount, i.currency)} subscription` : ''}</p></div>
              <div className="bg-gray-50 rounded-lg p-3"><p className="text-xs text-gray-500">Received</p><p className="text-lg font-bold">{formatMoney(i.amountPaid, i.currency)}</p><p className="text-[11px] text-gray-400">{formatMoney(left(i), i.currency)} outstanding</p></div>
              <div className="bg-gray-50 rounded-lg p-3"><p className="text-xs text-gray-500">Runserv / drivers still owed</p><p className="text-lg font-bold">{formatMoney(i.platformFee, i.currency)} / {formatMoney(i.driverPayable, i.currency)}</p></div></div>
            {i.payments?.length > 0 && <div><p className="font-semibold mb-1">Receipts</p><ul className="text-xs text-gray-600 space-y-0.5">{i.payments.map((p: any) => <li key={p.id}>{d(p.receivedAt)} · {formatMoney(p.amount, i.currency)} · {p.method}{p.reference ? ` · ${p.reference}` : ''}</li>)}</ul></div>}
            <p className="text-gray-500">{i.tripCount} trips · {i.totalDistanceKm} km · issued {d(i.issuedAt)} · due {d(i.dueDate)} {i.paidAt && `· paid ${d(i.paidAt)}`} {i.paymentReference && `· ref ${i.paymentReference}`}</p>
            <div><p className="font-semibold mb-1">Driver / partner payouts</p>
              {i.payouts.length === 0 ? <p className="text-gray-400">{i.status === 'PAID' ? 'None created yet.' : 'Created once the invoice is paid.'}</p> : (
                <table className="w-full"><tbody className="divide-y divide-gray-100">{i.payouts.map((p: any) => (
                  <tr key={p.id}><td className="py-1.5">{p.user.firstName} {p.user.lastName} <span className="text-xs text-gray-400">{p.user.role === 'DRIVER' ? 'Driver' : 'Partner'}</span></td>
                    <td className="text-right text-gray-500">{p.tripCount} trips</td><td className="text-right font-semibold">{formatMoney(p.netAmount, p.currency)}</td>
                    <td className="text-right"><Badge variant={p.status === 'PAID' ? 'success' : 'warning'}>{p.status}</Badge></td></tr>))}</tbody></table>)}</div>
            <div className="max-h-56 overflow-y-auto border border-gray-100 rounded-lg"><table className="w-full text-xs"><tbody className="divide-y divide-gray-100">{sel.trips.map((t: any) => (
              <tr key={t.id}><td className="p-2 text-gray-500">{d(t.tripAt)}</td><td className="p-2">{t.employee?.user?.firstName} {t.employee?.user?.lastName}</td>
                <td className="p-2 text-gray-500 truncate max-w-[220px]">{(t.ride ?? t.delivery)?.pickupAddress} → {(t.ride ?? t.delivery)?.dropoffAddress}</td><td className="p-2 text-right">{t.distanceKm?.toFixed(1)} km</td><td className="p-2 text-right font-medium">{formatMoney(t.fare, t.currency)}</td></tr>))}</tbody></table></div>
          </div>); })()}
      </Modal>

      <Modal isOpen={!!pay} onClose={() => setPay(null)} title="Record payment" size="sm"
        footer={<><Button variant="outline" onClick={() => setPay(null)}>Cancel</Button><Button variant="success" loading={busy} disabled={!(Number(amt) > 0)} onClick={markPaid}>Record payment</Button></>}>
        {pay && <div className="space-y-3 text-sm"><p>Outstanding on this invoice: <b>{formatMoney(left(pay), pay.currency)}</b>. Enter what you actually received — part payments are fine.</p>
          <Input label="Amount received" type="number" min={0} value={amt} onChange={(e) => setAmt(e.target.value)} />
          <Input label="Bank / transfer reference" value={ref} onChange={(e) => setRef(e.target.value)} />
          <p className="text-gray-500">When the invoice is fully paid, drivers and delivery partners are credited the rest of their share automatically.</p></div>}
      </Modal>
    </div>
  );
};
export default Invoices;
