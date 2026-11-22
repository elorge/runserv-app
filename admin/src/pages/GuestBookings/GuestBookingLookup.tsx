import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, Button, Input, Alert } from '@/components/common';
import { guestBookingsAPI } from '@/services/api/guestBookings';
import type { GuestBookingDetail } from '@/types/guestBooking';
import { StatusBadge, fmtDate, apiMessage } from './shared';

/** Support lookup: the guest reads out the reference and the number they booked with. Both must match; one uniform "not found" otherwise. */
const GuestBookingLookup: React.FC = () => {
  const [reference, setReference] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<GuestBookingDetail | null>(null);
  const valid = /^RS-[A-Z0-9]{6}$/i.test(reference.trim()) && phone.trim().length >= 7;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); if (!valid || busy) return;
    setBusy(true); setError(null); setFound(null);
    try { setFound(await guestBookingsAPI.lookup(reference, phone)); }
    catch (err) { setError(apiMessage(err, 'No booking matches that reference and phone number.')); }
    finally { setBusy(false); }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <div><Link to="/guest-bookings" className="text-sm text-primary-600">← Guest bookings</Link><h1 className="text-2xl font-bold text-gray-900">Look up a booking</h1></div>
      <Card>
        <form onSubmit={submit} className="space-y-3">
          <Input label="Booking reference" placeholder="RS-AB12CD" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={9} autoComplete="off" />
          <Input label="Phone number used to book" placeholder="+234…" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={20} autoComplete="off" inputMode="tel" />
          <Button type="submit" disabled={!valid || busy}>{busy ? 'Searching…' : 'Find booking'}</Button>
        </form>
      </Card>
      {error ? <Alert variant="error">{error}</Alert> : null}
      {found ? (
        <Card>
          <div className="flex items-center justify-between"><div><p className="font-semibold">{found.reference}</p><p className="text-sm text-gray-500">{fmtDate(found.createdAt)} · {found.service === 'PARCEL' ? 'Parcel' : 'Ride'}</p></div><StatusBadge status={found.status} /></div>
          <Link className="mt-3 inline-block text-primary-600 underline" to={`/guest-bookings/${found.id}`}>Open full detail</Link>
        </Card>
      ) : null}
    </div>
  );
};
export default GuestBookingLookup;
