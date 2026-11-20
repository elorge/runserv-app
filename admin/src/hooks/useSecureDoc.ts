import { useEffect, useState } from 'react';
import { documentsAPI, PRIVATE_MARKER, DocAccess } from '@/services/api/documents';

/** Resolves a stored document value to something an <img>/<iframe>/<a> can open. A redacted value is exchanged for a signed link. */
export function useSecureDoc(value?: string | null, access?: DocAccess) {
  const needsFetch = !!value && value === PRIVATE_MARKER && !!access;
  const [state, setState] = useState<{ url?: string; loading: boolean; error?: string }>({ url: needsFetch ? undefined : value || undefined, loading: needsFetch });
  useEffect(() => {
    let live = true;
    if (!needsFetch) { setState({ url: value && value !== PRIVATE_MARKER ? value : undefined, loading: false }); return; }
    setState({ loading: true });
    documentsAPI.access(access!)
      .then((r) => { if (live) setState({ url: r.format === 'pdf' ? `${r.url}#file.pdf` : r.url, loading: false }); })
      .catch((e: any) => { if (live) setState({ loading: false, error: e?.response?.data?.message || 'Could not open this document.' }); });
    return () => { live = false; };
  }, [value, access?.source, access?.id, access?.field]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}
