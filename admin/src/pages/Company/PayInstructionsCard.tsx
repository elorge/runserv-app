// Company Billing: where and how to pay by bank transfer. Pay into ANY listed account and quote the reference.
import React, { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Copy } from 'lucide-react';
import { Card } from '@/components/common';
import { companyPayAPI } from '@/services/api/partnerships';
import type { CompanyBankReceipt, CompanyPayInstructions } from '@/services/api/partnerships';
import { formatMoney } from '@/utils/money';

const copy = (t: string) => navigator.clipboard?.writeText(t).then(() => toast.success('Copied')).catch(() => undefined);
const Ref: React.FC<{ v: string }> = ({ v }) => <button type="button" onClick={() => copy(v)} className="inline-flex items-center gap-1 font-mono text-xs bg-gray-100 hover:bg-gray-200 rounded px-2 py-0.5">{v}<Copy className="h-3 w-3" /></button>;

const PayInstructionsCard: React.FC = () => {
  const [ins, setIns] = useState<CompanyPayInstructions | null>(null); const [rec, setRec] = useState<CompanyBankReceipt[]>([]); const [failed, setFailed] = useState(false);
  useEffect(() => { companyPayAPI.instructions().then(setIns).catch(() => setFailed(true)); companyPayAPI.receipts().then(setRec).catch(() => undefined); }, []);
  if (failed || !ins) return null;
  const m = (n: number | string | null) => formatMoney(Number(n), ins.currency);
  return (
    <Card padding={false} className="mb-5">
      <div className="px-5 pt-4 pb-2"><h3 className="font-semibold">Pay by bank transfer</h3><p className="text-xs text-gray-500">{ins.narration}</p></div>
      <div className="px-5 pb-4 space-y-4 text-sm">
        {ins.accounts.length ? (
          <div className="grid md:grid-cols-3 gap-3">{ins.accounts.map((a) => (
            <div key={a.id} className="border rounded-lg p-3"><div className="font-semibold">{a.bank}{a.isPrimary && <span className="ml-2 text-xs bg-emerald-100 text-emerald-700 px-1.5 rounded">Preferred</span>}</div>
              <button type="button" onClick={() => copy(a.accountNumber)} className="font-mono text-lg inline-flex items-center gap-1">{a.accountNumber}<Copy className="h-3.5 w-3.5" /></button><div className="text-gray-500">{a.accountName}</div></div>))}</div>
        ) : <p className="text-gray-500">No Runserv account is available for {ins.currency} yet. Contact Runserv.</p>}
        <div><div className="text-gray-500 mb-1">Top up your wallet. Use this reference:</div><Ref v={ins.walletReference} /></div>
        {ins.openInvoices.length > 0 && (
          <div><div className="text-gray-500 mb-1">Pay an invoice. Use that invoice’s own reference:</div>
            <table className="w-full"><tbody className="divide-y">{ins.openInvoices.map((i) => <tr key={i.invoiceId}><td className="py-1.5">{i.invoiceNumber}</td><td>{m(i.outstanding)} due</td><td><Ref v={i.reference} /></td></tr>)}</tbody></table></div>)}
        {rec.length > 0 && (
          <div><div className="text-gray-500 mb-1">Recent bank payments received</div>
            <table className="w-full"><tbody className="divide-y">{rec.slice(0, 8).map((r) => <tr key={r.id}><td className="py-1.5">{new Date(r.receivedAt).toLocaleDateString()}</td><td>{r.bankPartner?.displayName}</td><td className="font-medium">{m(r.amount)}</td><td className="text-gray-500">{r.status === 'MATCHED' ? 'Applied' : 'Being checked'}</td></tr>)}</tbody></table></div>)}
      </div>
    </Card>
  );
};
export default PayInstructionsCard;
