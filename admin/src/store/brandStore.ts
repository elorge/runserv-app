// White label: the organisation's name, logo and colours, resolved from the address the portal is opened on
// (<slug>.business.runserv.org or the company's own domain). Loaded before login so the sign-in page is already branded.
import { create } from 'zustand';
import api from '@/services/api';
import { applyBrandColor } from '@/utils/brand';

export interface Brand { name: string; logoUrl: string | null; color: string; accent: string; tagline: string | null; supportEmail: string | null; whiteLabel: boolean }
const DEFAULT: Brand = { name: 'Runserv', logoUrl: null, color: '#1D4ED8', accent: '#0EA5E9', tagline: 'Business rides & deliveries', supportEmail: null, whiteLabel: false };

interface BrandState { brand: Brand; loaded: boolean; load: () => Promise<void>; set: (b: Partial<Brand>) => void }

const apply = (b: Brand, host: string) => {
  // Only recolour for a white-label organisation: Runserv's own admin keeps the default look.
  applyBrandColor(b.whiteLabel ? b.color : null);
  document.title = b.name;
  const base = (api.defaults.baseURL || '/api').replace(/\/$/, '');
  const link = document.querySelector('link[rel="manifest"]') as HTMLLinkElement | null;
  if (link && b.whiteLabel) link.href = `${base}/public/manifest.webmanifest?host=${encodeURIComponent(host)}`;
  if (b.whiteLabel && b.logoUrl) { const fav = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null; if (fav) fav.href = b.logoUrl; }
};

export const useBrandStore = create<BrandState>((set, get) => ({
  brand: DEFAULT, loaded: false,
  load: async () => {
    const host = window.location.hostname;
    try {
      const r = await api.get('/public/brand', { params: { host } });
      const brand: Brand = r.data?.data?.brand ?? DEFAULT;
      set({ brand, loaded: true }); apply(brand, host);
    } catch { set({ loaded: true }); }
  },
  /** After the org admin saves branding, show it straight away. */
  set: (b) => { const next = { ...get().brand, ...b }; set({ brand: next }); apply({ ...next, whiteLabel: true }, window.location.hostname); },
}));
