// mobile/src/hooks/useOrgAccount.js
// Loads the signed-in customer's organisation state (NONE / PENDING / REJECTED / ACTIVE).
// A short in-memory cache keeps the booking screens snappy; call refresh() after joining etc.
import { useState, useEffect, useCallback, useRef } from 'react';
import { corporateAPI } from '../services/api';
import { useAuth } from '../context/AuthContext';

let cache = { at: 0, userId: null, data: null };
const TTL = 20_000;

export const clearOrgCache = () => { cache = { at: 0, userId: null, data: null }; };

export const useOrgAccount = () => {
  const { user } = useAuth();
  const isCustomer = user?.role === 'CUSTOMER';
  const fresh = cache.userId === user?.id && Date.now() - cache.at < TTL;
  const [data, setData] = useState(fresh ? cache.data : null);
  const [loading, setLoading] = useState(isCustomer && !fresh);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    if (!isCustomer) { setLoading(false); return null; }
    try {
      const res = await corporateAPI.getMyAccount();
      const d = res?.data ?? res;
      cache = { at: Date.now(), userId: user?.id, data: d };
      if (alive.current) setData(d);
      return d;
    } catch {
      if (alive.current) setData({ status: 'NONE' });
      return null;
    } finally { if (alive.current) setLoading(false); }
  }, [isCustomer, user?.id]);

  useEffect(() => { alive.current = true; if (!fresh) refresh(); return () => { alive.current = false; }; }, [refresh]); // eslint-disable-line

  return { org: data, loading, refresh, isMember: data?.status === 'ACTIVE' };
};
