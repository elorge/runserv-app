import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { documentsAPI, DocAccess } from '@/services/api/documents';

/** A link that fetches a short-lived signed URL on click (the request is audited server-side). */
export const SecureDocLink: React.FC<{ access: DocAccess; className?: string; children: React.ReactNode }> = ({ access, className, children }) => {
  const [busy, setBusy] = useState(false);
  const open = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (busy) return;
    const win = window.open('', '_blank'); // open synchronously so the browser does not block the pop-up
    setBusy(true);
    try {
      const r = await documentsAPI.access(access);
      if (win) { win.opener = null; win.location.href = r.url; }
    } catch (err: any) {
      win?.close();
      toast.error(err?.response?.data?.message || 'You do not have permission to open this document.');
    } finally { setBusy(false); }
  };
  return <a href="#" onClick={open} className={className} aria-busy={busy}>{children}</a>;
};
export default SecureDocLink;
