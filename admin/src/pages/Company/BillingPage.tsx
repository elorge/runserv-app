import React, { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Printer, ArrowLeft, Wallet } from 'lucide-react';
import toast from 'react-hot-toast';
import { Card, Button, Badge, Spinner, Alert, Modal, Input } from '@/components/common';
import { companyAPI, errMsg } from '@/services/api/company';
import { formatMoney } from '@/utils/money';
import type { Invoice } from '@/types/company';
import PayInstructionsCard from './PayInstructionsCard';
import TripTable, { exportTrips } from './TripTable';
import { PageHeader, StatCard, monthLabel, fmtKm, Empty, fmtDT } from './ui';

type Bill = Awaited<ReturnType<typeof companyAPI.billing>>;
type Detail = Awaited<ReturnType<typeof companyAPI.invoice>>;
type Txs = Awaited<ReturnType<typeof companyAPI.walletTransactions>>;
const d = (s: string | null) => (s ? new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const tone = (s: string) => (s === 'PAID' ? 'success' : s === 'OVERDUE' ? 'error' : 'warning') as 'success' | 'error' | 'warning';
const MODE = { PREPAID: 'Prepaid wallet', POSTPAID: 'Monthly invoice', HYBRID: 'Wallet + credit' } as const;

const BillingPage: React.FC = () => {
  const [sp, setSp] = useSearchParams();
  const [bill, setBill] = useState<Bill | null>(null); const [txs, setTxs] = useState<Txs | null>(null); const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true); const [topUp, setTopUp] = useState(false); const [amount, setAmount] = useState('100000'); const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([companyAPI.billing(), companyAPI.walletTransactions().catch(() => null)]).then(([b, t]) => { setBill(b); setTxs(t); }).catch((e) => toast.error(errMsg(e))).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  // Coming back from the card/bank payment page: confirm it and credit the wallet.
  useEffect(() => {
    const ref = sp.get('reference') || sp.get('trxref');
    if (!ref || !ref.startsWith('ORGTOP-')) return;
    companyAPI.verifyTopUp(ref).then(() => { toast.success('Wallet topped up'); load(); }).catch((e) => toast.error(errMsg(e))).finally(() => setSp({}));
  }, [sp, setSp, load]);

  const startTopUp = async () => {
    setBusy(true);
    try { const r = await companyAPI.initiateTopUp(Number(amount)); window.location.href = r.authorizationUrl; }
    catch (e) { toast.error(errMsg(e)); setBusy(false); }
  };
  const open = (id: string) => companyAPI.invoice(id).then(setDetail).catch((e) => toast.error(errMsg(e)));

  if (loading) return <div className="py-24 flex justify-center"><Spinner size="lg" /></div>;
  if (!bill) return null;
  const cur = bill.currency; const money = (n: number) => formatMoney(n, cur); const f = bill.funding;

  if (detail) {
    const inv = detail.invoice;
    return (
      <div>
        <button onClick={() => setDetail(null)} className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 mb-3 print:hidden"><ArrowLeft className="h-4 w-4" />All invoices</button>
        <Card className="mb-4">
          <div className="flex flex-wrap justify-between gap-4">
            <div><p className="text-xs uppercase tracking-wide text-gray-400">Invoice</p><h1 className="text-2xl font-bold">{inv.number}</h1>
              <p className="text-sm text-gray-500 mt-1">{detail.company.name}{detail.company.address ? ` · ${detail.company.address}` : ''}</p><p className="text-sm text-gray-500">Billing period: {monthLabel(inv.period)}</p></div>
            <div className="text-right"><Badge variant={tone(inv.status)}>{inv.status.replace('_', ' ')}</Badge><p className="text-3xl font-bold mt-2 tabular-nums">{money(inv.total)}</p>
              <p className="text-xs text-gray-400 mt-1">Issued {d(inv.issuedAt)} · Due {d(inv.dueDate)}{inv.paidAt ? ` · Paid ${d(inv.paidAt)}` : ''}</p>
              {inv.outstanding > 0 && inv.paid > 0 && <p className="text-sm text-amber-700 mt-1">{money(inv.paid)} paid · {money(inv.outstanding)} outstanding</p>}</div>
          </div>
          <div className="mt-4 text-sm text-gray-600 space-y-0.5">
            <p>Trips on credit: <b>{money(inv.tripsAmount)}</b>{inv.subscription > 0 && <> · Platform subscription: <b>{money(inv.subscription)}</b></>}</p>
            {detail.payments.length > 0 && <p className="text-xs text-gray-400">Receipts: {detail.payments.map((p) => `${money(p.amount)} on ${d(p.receivedAt)}${p.reference ? ` (${p.reference})` : ''}`).join(' · ')}</p>}
          </div>
          <div className="flex gap-2 mt-4 print:hidden"><Button variant="outline" onClick={() => window.print()}><Printer className="h-4 w-4 inline mr-1.5" />Print / save PDF</Button><Button variant="outline" onClick={() => exportTrips(detail.trips, inv.number)}>Download Excel</Button></div>
          {inv.status !== 'PAID' && <p className="text-sm text-gray-500 mt-4 print:hidden">Pay by bank transfer and quote <b>{inv.number}</b>. Runserv records the receipt (part payments are fine) and marks the invoice paid once it is complete.</p>}
        </Card>
        <div className="grid lg:grid-cols-2 gap-4 mb-4">
          <Card padding={false}><div className="px-5 pt-4 pb-2"><h3 className="font-semibold">By cost centre</h3></div>
            <table className="min-w-full text-sm"><tbody className="divide-y divide-gray-100">{detail.byCostCenter.map((c) => (<tr key={c.costCenter}><td className="px-5 py-2.5 font-mono text-xs">{c.costCenter}</td><td className="px-5 py-2.5 text-right text-gray-500">{c.trips} trips</td><td className="px-5 py-2.5 text-right font-semibold tabular-nums">{money(c.total)}</td></tr>))}</tbody></table></Card>
          <Card padding={false}><div className="px-5 pt-4 pb-2"><h3 className="font-semibold">By staff member</h3></div>
            <table className="min-w-full text-sm"><tbody className="divide-y divide-gray-100">{detail.byEmployee.map((e) => (<tr key={e.id}><td className="px-5 py-2.5">{e.name} <span className="text-gray-400 text-xs">{e.staffNumber}</span></td><td className="px-5 py-2.5 text-right text-gray-500">{fmtKm(e.distanceKm)}</td><td className="px-5 py-2.5 text-right font-semibold tabular-nums">{money(e.total)}</td></tr>))}</tbody></table></Card>
        </div>
        <Card padding={false}><div className="px-5 pt-4 pb-2"><h3 className="font-semibold">All trips on this invoice</h3></div>
          <TripTable trips={detail.trips} currency={cur} onChange={(t) => setDetail({ ...detail, trips: detail.trips.map((x) => (x.id === t.id ? t : x)) })} /></Card>
      </div>
    );
  }

  const overdue = bill.invoices.find((i) => i.status === 'OVERDUE');
  const usesWallet = bill.billingMode !== 'POSTPAID'; const usesCredit = bill.billingMode !== 'PREPAID';
  return (
    <div>
      <PageHeader title="Billing & wallet" subtitle={`Your arrangement with Runserv: ${MODE[bill.billingMode]}`}
        right={usesWallet ? <Button onClick={() => setTopUp(true)}><Wallet className="h-4 w-4 inline mr-1.5" />Top up wallet</Button> : undefined} />
      {overdue && <Alert variant="error" className="mb-4" title="Overdue">Invoice {overdue.number} is overdue. Company rides pause for your staff until it is settled.</Alert>}
      {usesWallet && f.walletAvailable <= 0 && <Alert variant="warning" className="mb-4" title="Wallet empty">Staff cannot book on the company until the wallet is topped up.</Alert>}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        {usesWallet && <StatCard label="Wallet available" value={money(f.walletAvailable)} sub={f.held ? `${money(f.held)} held for trips in progress` : money(f.walletBalance) + ' balance'} tone={f.walletAvailable <= 0 ? 'bad' : 'default'} />}
        {usesCredit && <StatCard label="Credit available" value={money(f.creditAvailable)} sub={`${money(f.creditExposure)} used of ${money(f.creditLimit)}`} tone={f.creditLimit > 0 && f.creditExposure / f.creditLimit > 0.8 ? 'warn' : 'default'} />}
        <StatCard label={`${monthLabel(bill.period)} so far`} value={money(bill.month.total)} sub={`${bill.month.trips} trips · ${fmtKm(bill.month.distanceKm)}`} />
        <StatCard label="This month funded by" value={`${money(bill.month.fromWallet)} wallet`} sub={usesCredit ? `${money(bill.month.onCredit)} on credit · invoiced ${d(bill.month.willBeInvoicedOn)}` : 'every trip is paid from the wallet'} />
      </div>
      {bill.billingMode === 'PREPAID' && <p className="text-xs text-gray-500 mb-4">Monthly invoicing (pay after the month) is available to verified organisations with an agreed credit limit — ask Runserv.</p>}

      <PayInstructionsCard />

      {usesCredit && (
        <Card padding={false} className="mb-5">
          <div className="px-5 pt-4 pb-2"><h3 className="font-semibold">Invoices</h3></div>
          {bill.invoices.length === 0 ? <Empty>Your first invoice is issued at the start of next month.</Empty> : (
            <table className="min-w-full text-sm"><thead className="bg-gray-50 text-xs uppercase text-gray-500"><tr><th className="text-left px-5 py-2">Invoice</th><th className="text-left px-5 py-2">Month</th><th className="text-right px-5 py-2">Amount</th><th className="text-right px-5 py-2">Outstanding</th><th className="text-left px-5 py-2">Due</th><th className="px-5 py-2">Status</th></tr></thead>
              <tbody className="divide-y divide-gray-100">{bill.invoices.map((i: Invoice) => (
                <tr key={i.id} onClick={() => open(i.id)} className="hover:bg-gray-50 cursor-pointer"><td className="px-5 py-3 font-mono text-xs">{i.number}</td><td className="px-5 py-3">{monthLabel(i.period)}</td>
                  <td className="px-5 py-3 text-right font-semibold tabular-nums">{money(i.total)}</td><td className="px-5 py-3 text-right tabular-nums">{i.outstanding > 0 ? money(i.outstanding) : '—'}</td><td className="px-5 py-3">{d(i.dueDate)}</td>
                  <td className="px-5 py-3 text-center"><Badge variant={tone(i.status)}>{i.status.replace('_', ' ')}</Badge></td></tr>))}</tbody></table>)}
        </Card>)}

      {usesWallet && txs && (
        <Card padding={false}>
          <div className="px-5 pt-4 pb-2"><h3 className="font-semibold">Wallet activity</h3></div>
          {txs.transactions.length === 0 ? <Empty>No wallet activity yet.</Empty> : (
            <table className="min-w-full text-sm"><tbody className="divide-y divide-gray-100">{txs.transactions.map((t) => (
              <tr key={t.id}><td className="px-5 py-2.5 text-gray-500 whitespace-nowrap">{fmtDT(t.createdAt)}</td><td className="px-5 py-2.5">{t.description}</td>
                <td className={`px-5 py-2.5 text-right font-semibold tabular-nums ${t.amount < 0 ? 'text-gray-900' : 'text-emerald-600'}`}>{t.amount > 0 ? '+' : ''}{money(t.amount)}</td><td className="px-5 py-2.5 text-right text-gray-400 tabular-nums">{money(t.balanceAfter)}</td></tr>))}</tbody></table>)}
        </Card>)}

      <Modal isOpen={topUp} onClose={() => setTopUp(false)} title="Top up wallet" footer={<><Button variant="outline" onClick={() => setTopUp(false)}>Cancel</Button><Button loading={busy} disabled={!(Number(amount) >= 1000)} onClick={startTopUp}>Pay securely</Button></>}>
        <div className="space-y-3 text-sm"><p className="text-gray-600">Pay by card or bank transfer. The wallet is credited as soon as the payment is confirmed. For large transfers you can also pay Runserv directly and ask them to credit the wallet.</p>
          <Input label={`Amount (${cur})`} type="number" min={1000} value={amount} onChange={(e) => setAmount(e.target.value)} />
          <div className="flex gap-2 flex-wrap">{[50000, 100000, 500000, 1000000].map((a) => <button key={a} onClick={() => setAmount(String(a))} className="text-xs px-2.5 py-1 rounded-full border border-gray-300 hover:bg-gray-50">{money(a)}</button>)}</div></div>
      </Modal>
    </div>
  );
};
export default BillingPage;
