// M13: stored identity / vehicle documents are never returned as links. Ask the API for a short-lived signed link (audited).
import api from './index';

export const PRIVATE_MARKER = 'private://document';
export type DocAccess = { source: 'DRIVER_PROFILE' | 'DELIVERY_PROFILE' | 'FLEET_DOCUMENT'; id: string; field: string; reason?: string };

export const documentsAPI = {
  access: async (a: DocAccess): Promise<{ url: string; expiresAt: string | null; legacy: boolean; format: string | null }> => {
    const res: any = await api.post('/documents/access', a);
    return res?.data?.data ?? res?.data;
  },
};
