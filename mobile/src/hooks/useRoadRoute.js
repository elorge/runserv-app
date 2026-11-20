// mobile/src/hooks/useRoadRoute.js
import { useEffect, useRef, useState } from 'react';
import { fetchRoadRoute } from '../services/routing';

/**
 * Road route between two {latitude, longitude} points; null until loaded or if unavailable.
 * freezeFrom: keep the FIRST `from` seen (e.g. driver start) so a moving driver does not re-request
 * a route on every GPS ping; a new route is only fetched when `to` changes or the route is switched off.
 */
export default function useRoadRoute(from, to, { freezeFrom = false } = {}) {
  const [route, setRoute] = useState(null);
  const frozen = useRef(null);
  const on = from?.latitude != null && from?.longitude != null && to?.latitude != null && to?.longitude != null;
  if (!on) frozen.current = null;
  else if (freezeFrom && !frozen.current) frozen.current = { latitude: from.latitude, longitude: from.longitude };
  const f = on ? (freezeFrom ? frozen.current : from) : null;
  const k = on ? [f.latitude, f.longitude, to.latitude, to.longitude].map((n) => Number(n).toFixed(4)).join(',') : '';

  useEffect(() => {
    if (!k) { setRoute(null); return undefined; }
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let live = true;
    fetchRoadRoute(f, { latitude: to.latitude, longitude: to.longitude }, { signal: ctl?.signal })
      .then((r) => { if (live) setRoute(r); });
    return () => { live = false; ctl?.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k]);
  return route;
}
