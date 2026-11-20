// Second step of staff sign-in: enter the authenticator-app code (or a backup code), or enrol an authenticator the first time.
// The token from the password step only works for the /auth/mfa routes; the token returned here is the full one.
import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import toast from 'react-hot-toast';
import { Button, Alert } from '@/components/common';
import { authAPI } from '@/services/api/auth';

interface Props { token: string; enrolled: boolean; onDone: (fullToken: string) => void; onCancel: () => void }
const msg = (e: any) => e?.response?.data?.message || e?.response?.data?.errors?.[0]?.msg || 'Something went wrong. Please try again.';
const inputCls = 'block w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm text-center tracking-widest text-lg focus:outline-none focus:ring-2 focus:ring-primary-500';

const MfaStep: React.FC<Props> = ({ token, enrolled, onDone, onCancel }) => {
  const [code, setCode] = useState(''); const [useBackup, setUseBackup] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null); const [qr, setQr] = useState('');
  const [codes, setCodes] = useState<{ list: string[]; token: string } | null>(null); const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (enrolled) return;
    authAPI.mfaSetup(token).then(async (s) => { setSetup(s); setQr(await QRCode.toDataURL(s.otpauthUrl, { margin: 1, width: 192 })); }).catch((e) => setError(msg(e)));
  }, [enrolled, token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(''); setBusy(true);
    try {
      if (!enrolled) { const r = await authAPI.mfaEnable(token, code.trim()); setCodes({ list: r.backupCodes, token: r.token }); }
      else {
        const r = await authAPI.mfaVerify(token, useBackup ? { backupCode: code.trim() } : { code: code.trim() });
        if (r.via === 'backup') toast(`Backup code used. ${r.backupCodesLeft ?? 0} left. Generate a new set soon.`, { icon: '⚠️' });
        onDone(r.token);
      }
    } catch (err) { setError(msg(err)); setCode(''); } finally { setBusy(false); }
  };

  if (codes) return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold text-gray-900">Save your backup codes</h3>
      <p className="text-sm text-gray-600">Each code works once if you lose your phone. They are shown only now. Store them somewhere safe.</p>
      <div className="grid grid-cols-2 gap-2 font-mono text-sm bg-gray-50 border rounded-lg p-3">{codes.list.map((c) => <span key={c}>{c}</span>)}</div>
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => { navigator.clipboard?.writeText(codes.list.join('\n')).then(() => toast.success('Copied')).catch(() => undefined); }}>Copy</Button>
        <Button variant="outline" onClick={() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([codes.list.join('\n')], { type: 'text/plain' })); a.download = 'runserv-backup-codes.txt'; a.click(); }}>Download</Button>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I have saved these codes</label>
      <Button className="w-full" disabled={!saved} onClick={() => onDone(codes.token)}>Continue</Button>
    </div>
  );

  return (
    <form onSubmit={submit} className="space-y-4">
      <h3 className="text-lg font-semibold text-gray-900">{enrolled ? 'Two-step sign-in' : 'Set up two-step sign-in'}</h3>
      {error && <Alert variant="error">{error}</Alert>}
      {!enrolled && (
        <div className="space-y-3 text-sm text-gray-600">
          <p>1. Install an authenticator app (Google Authenticator, Microsoft Authenticator, Authy or 1Password).</p>
          <p>2. Scan this code, or enter the key by hand.</p>
          {qr ? <img src={qr} alt="Authenticator QR code" className="mx-auto h-48 w-48" /> : !error && <div className="h-48 flex items-center justify-center text-gray-400">Preparing…</div>}
          {setup && <p className="text-center font-mono text-xs break-all bg-gray-50 border rounded p-2 select-all">{setup.secret}</p>}
          <p>3. Enter the 6-digit code the app shows.</p>
        </div>
      )}
      {enrolled && <p className="text-sm text-gray-600">{useBackup ? 'Enter one of your backup codes.' : 'Enter the 6-digit code from your authenticator app.'}</p>}
      <input autoFocus inputMode={useBackup ? 'text' : 'numeric'} autoComplete="one-time-code" className={inputCls} value={code} onChange={(e) => setCode(e.target.value)} placeholder={useBackup ? 'XXXXX-XXXXX' : '123456'} maxLength={useBackup ? 14 : 8} required />
      <Button type="submit" loading={busy} className="w-full" disabled={!enrolled && !setup}>{enrolled ? 'Verify' : 'Turn on and continue'}</Button>
      <div className="flex justify-between text-sm">
        {enrolled ? <button type="button" className="text-primary-600" onClick={() => { setUseBackup(!useBackup); setCode(''); setError(''); }}>{useBackup ? 'Use authenticator app' : 'Use a backup code'}</button> : <span />}
        <button type="button" className="text-gray-500" onClick={onCancel}>Back to sign in</button>
      </div>
    </form>
  );
};
export default MfaStep;
