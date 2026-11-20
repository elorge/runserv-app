// admin/src/pages/Settings/MapSettings.tsx — M14: choose the map technology WITHOUT touching code or rebuilding the apps.
import React, { useEffect, useState } from 'react';
import { Map as MapIcon, Save, FlaskConical, CheckCircle, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '@/services/api';
import { Button, Alert } from '@/components/common';

type Cfg = { renderer: string; routing: string; places: string; styleUrl: string; routingFallback: boolean; updatedAt?: string | null };
type Avail = { production?: boolean; routing: Record<string, boolean>; places: Record<string, boolean>; osrmIsPublicDemo: boolean };

const RENDERERS = [
  { v: 'maplibre', label: 'MapLibre (default)', hint: 'Open-source renderer. You supply the tile style below. No per-map-load Google fees.' },
  { v: 'google', label: 'Google Maps', hint: 'Needs an app build that includes Google Maps keys (see docs/MAP_PROVIDERS.md). Apps without it fall back to MapLibre automatically.' },
  { v: 'osm', label: 'OpenStreetMap (basic)', hint: 'Simple fallback renderer. Good for emergencies, not for scale.' },
];
const ROUTING = [
  { v: 'osrm', label: 'OSRM (your own server recommended)' },
  { v: 'google', label: 'Google Routes (traffic-aware)' },
];
const PLACES = [
  { v: 'auto', label: 'Automatic (Google if its key exists, otherwise Photon)' },
  { v: 'photon', label: 'Photon (free)' },
  { v: 'google', label: 'Google Places' },
];

const Radio: React.FC<{ name: string; value: string; current: string; label: string; hint?: string; disabled?: boolean; onChange: (v: string) => void }> = ({ name, value, current, label, hint, disabled, onChange }) => (
  <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer ${current === value ? 'border-primary-500 bg-primary-50' : 'border-gray-200'} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}>
    <input type="radio" name={name} value={value} checked={current === value} disabled={disabled} onChange={() => onChange(value)} className="mt-1" />
    <span><span className="text-sm font-medium text-gray-800">{label}</span>{disabled && <span className="ml-2 text-xs text-amber-700">(server key not configured)</span>}{hint && <span className="block text-xs text-gray-500">{hint}</span>}</span>
  </label>
);

const MapSettings: React.FC = () => {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [avail, setAvail] = useState<Avail | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [ack, setAck] = useState(false);

  useEffect(() => {
    api.get('/admin/maps/config').then((r: any) => { const d = r?.data?.data ?? r?.data; setCfg(d.config); setAvail(d.availability); setWarnings(d.warnings ?? []); })
      .catch((e: any) => toast.error(e?.response?.data?.message || 'Could not load map settings'));
  }, []);

  if (!cfg || !avail) return <div className="p-6 text-sm text-gray-500">Loading map settings…</div>;
  const set = (k: keyof Cfg, v: any) => { setCfg({ ...cfg, [k]: v }); setAck(false); };
  const termsWarning = warnings.some((w) => /terms/i.test(w));

  const save = async () => {
    setSaving(true);
    try {
      const r: any = await api.put('/admin/maps/config', { renderer: cfg.renderer, routing: cfg.routing, places: cfg.places, styleUrl: cfg.styleUrl, routingFallback: cfg.routingFallback, acknowledgeTerms: ack });
      const d = r?.data?.data ?? r?.data;
      setCfg(d.config); setWarnings(d.warnings ?? []);
      toast.success('Saved. Apps pick this up within a minute.');
    } catch (e: any) { toast.error(e?.response?.data?.message || 'Could not save'); } finally { setSaving(false); }
  };

  const test = async () => {
    setTesting(true); setTestResult(null);
    try { // Lagos: Ikeja to Victoria Island, a sample trip to prove the selected provider works
      const r: any = await api.post('/admin/maps/test-route', { from: { latitude: 6.6018, longitude: 3.3515 }, to: { latitude: 6.4281, longitude: 3.4219 } });
      setTestResult((r?.data?.data ?? r?.data));
    } catch (e: any) { toast.error(e?.response?.data?.message || 'Test failed'); } finally { setTesting(false); }
  };

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3"><MapIcon className="h-6 w-6 text-primary-600" /><div><h1 className="text-xl font-semibold text-gray-900">Map provider</h1><p className="text-sm text-gray-500">Switch map technology instantly. No code change and no app update needed (except enabling Google rendering — see note).</p></div></div>

      {avail.osrmIsPublicDemo && cfg.routing === 'osrm' && <Alert variant={avail.production ? 'error' : 'warning'}>{avail.production ? 'OSRM is not configured and the public demo server is refused in production, so routes will not load. Set OSRM_URL to your own routing server (or choose Google routing).' : 'Routing uses the public OSRM demo server, which is for development only. Set OSRM_URL to your own routing server before launch.'}</Alert>}
      {warnings.filter((w) => !/OSRM/.test(w)).map((w) => <Alert key={w} variant="warning">{w}</Alert>)}

      <section className="space-y-2"><h2 className="text-sm font-semibold text-gray-700">1. Map display (what drivers and riders see)</h2>
        {RENDERERS.map((o) => <Radio key={o.v} name="renderer" value={o.v} current={cfg.renderer} label={o.label} hint={o.hint} onChange={(v) => set('renderer', v)} />)}
        <label className="block text-xs text-gray-600 pt-1">MapLibre tile style URL (https) — leave blank for the built-in basic style
          <input value={cfg.styleUrl} onChange={(e) => set('styleUrl', e.target.value)} placeholder="https://api.maptiler.com/maps/streets/style.json?key=…" className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
        </label>
      </section>

      <section className="space-y-2"><h2 className="text-sm font-semibold text-gray-700">2. Road routes, distance and time</h2>
        {ROUTING.map((o) => <Radio key={o.v} name="routing" value={o.v} current={cfg.routing} label={o.label} disabled={!avail.routing[o.v]} onChange={(v) => set('routing', v)} />)}
        <label className="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" checked={cfg.routingFallback} onChange={(e) => set('routingFallback', e.target.checked)} /> If the chosen provider fails, try the other one</label>
      </section>

      <section className="space-y-2"><h2 className="text-sm font-semibold text-gray-700">3. Address search</h2>
        {PLACES.map((o) => <Radio key={o.v} name="places" value={o.v} current={cfg.places} label={o.label} disabled={!avail.places[o.v]} onChange={(v) => set('places', v)} />)}
      </section>

      {termsWarning && avail.production && (
        <label className="flex items-start gap-2 text-sm text-gray-800 p-3 rounded-lg border border-amber-300 bg-amber-50">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-1" />
          <span>I have reviewed the provider's current terms for this combination and accept responsibility for it. (Recorded against my account.)</span>
        </label>
      )}

      <div className="flex gap-3">
        <Button onClick={save} disabled={saving || (termsWarning && !!avail.production && !ack)}><Save className="h-4 w-4 mr-1" />{saving ? 'Saving…' : 'Save'}</Button>
        <Button variant="outline" onClick={test} disabled={testing}><FlaskConical className="h-4 w-4 mr-1" />{testing ? 'Testing…' : 'Test selected routing'}</Button>
      </div>

      {testResult && (testResult.ok
        ? <Alert variant="success"><CheckCircle className="inline h-4 w-4 mr-1" />{testResult.provider} OK — {(testResult.distanceM / 1000).toFixed(1)} km, {Math.round(testResult.durationS / 60)} min, {testResult.ms} ms (test uses the saved setting)</Alert>
        : <Alert variant="error"><AlertTriangle className="inline h-4 w-4 mr-1" />{testResult.provider} failed: {testResult.error}</Alert>)}

      <Alert variant="info">Google map <em>display</em> also needs Google keys inside the app build (done once, at build time). Routing and address search switch instantly from here. Last saved: {cfg.updatedAt ? new Date(cfg.updatedAt).toLocaleString() : 'never (using server defaults)'}.</Alert>
    </div>
  );
};
export default MapSettings;
