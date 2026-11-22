import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, Pagination, Spinner, Alert, Input, Select, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/common';
import { guestBookingsAPI } from '@/services/api/guestBookings';
import { useDebounce } from '@/hooks/useDebounce';
import type { GuestBookingRow, GuestService } from '@/types/guestBooking';
import { StatusBadge, fmtDate, money, apiMessage } from './shared';

const STATUSES = ['', 'REQUESTED', 'ACCEPTED', 'ASSIGNED', 'PICKED_UP', 'IN_TRANSIT', 'IN_PROGRESS', 'COMPLETED', 'DELIVERED', 'CANCELLED'];

const GuestBookingQueue: React.FC = () => {
  const [rows, setRows] = useState<GuestBookingRow[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [service, setService] = useState<GuestService | ''>('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const q = useDebounce(search, 400);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { const r = await guestBookingsAPI.list({ page, limit: 25, service, status, q }); setRows(r.bookings); setPages(r.pagination.pages || 1); setTotal(r.pagination.total); }
    catch (e) { setRows([]); setError(apiMessage(e, 'Could not load guest bookings.')); }
    finally { setLoading(false); }
  }, [page, service, status, q]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [service, status, q]);

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl font-bold text-gray-900">Guest bookings</h1><p className="text-sm text-gray-500">Rides and parcels booked without an account. Phone numbers are masked.</p></div>
        <div className="flex gap-3 text-sm"><Link to="/guest-bookings/lookup" className="text-primary-600 underline">Look up a booking</Link><Link to="/guest-bookings/sms" className="text-primary-600 underline">SMS queue</Link><Link to="/guest-bookings/abuse" className="text-primary-600 underline">Abuse signals</Link></div>
      </div>

      <Card>
        <div className="grid gap-3 md:grid-cols-3">
          <Input label="Reference" placeholder="e.g. RS-AB12CD" value={search} onChange={(e) => setSearch(e.target.value)} maxLength={40} />
          <Select label="Service" value={service} onChange={(e: any) => setService((e.target?.value ?? e) as GuestService | '')}
            options={[{ value: '', label: 'Rides and parcels' }, { value: 'RIDE', label: 'Rides' }, { value: 'PARCEL', label: 'Parcels' }]} />
          <Select label="Status" value={status} onChange={(e: any) => setStatus(e.target?.value ?? e)} options={STATUSES.map((s) => ({ value: s, label: s ? s.replace(/_/g, ' ') : 'Any status' }))} />
        </div>
      </Card>

      {error ? <Alert variant="error">{error}</Alert> : null}
      <Card padding={false}>
        {loading ? <div className="flex justify-center p-10"><Spinner /></div> : (
          <Table>
            <TableHeader><TableRow><TableHead>Reference</TableHead><TableHead>Created</TableHead><TableHead>Service</TableHead><TableHead>Status</TableHead><TableHead>Market</TableHead><TableHead>Phone</TableHead><TableHead>Fare</TableHead></TableRow></TableHeader>
            <TableBody>
              {rows.length === 0 ? <tr><td colSpan={7} className="px-6 py-8 text-center text-gray-500">No guest bookings match.</td></tr> : rows.map((b) => (
                <TableRow key={b.id}>
                  <TableCell><Link className="font-medium text-primary-600" to={`/guest-bookings/${b.id}`}>{b.reference}</Link>{b.blocked ? <span className="ml-2 text-xs text-red-600">blocked</span> : null}</TableCell>
                  <TableCell>{fmtDate(b.createdAt)}</TableCell><TableCell>{b.service === 'PARCEL' ? 'Parcel' : 'Ride'}</TableCell>
                  <TableCell><StatusBadge status={b.status} /></TableCell><TableCell>{b.countryCode ?? '—'}</TableCell><TableCell>{b.phone}</TableCell><TableCell>{money(b.fare, b.currency)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
      <div className="flex items-center justify-between"><span className="text-sm text-gray-500">{total} booking{total === 1 ? '' : 's'}</span><Pagination currentPage={page} totalPages={pages} onPageChange={setPage} /></div>
    </div>
  );
};
export default GuestBookingQueue;
