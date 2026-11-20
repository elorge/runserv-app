// M13: stored identity / vehicle documents are never returned as links; ask the API for a short-lived signed link.
import api from './api';

export const PRIVATE_MARKER = 'private://document';

/** Returns a fetchable URL: the value itself when it is already a link, or a fresh signed link for a private document. */
export const resolveDocUrl = async (value, access) => {
  if (value !== PRIVATE_MARKER && !String(value || '').startsWith('cldp:')) return value;
  const res = await api.post('/documents/access', access);
  const url = res?.data?.data?.url ?? res?.data?.url ?? res?.url;
  if (!url) throw new Error('Could not open this document.');
  return url;
};
