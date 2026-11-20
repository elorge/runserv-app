// admin-web/src/i18n/index.ts
// Interface language for the admin console. Deliberately small: English is the source text, and
// each extra language is a dictionary (see fr.ts) applied by domTranslate.ts. Anything without a
// translation simply stays in English, so a missing word can never break a screen.
import { useAuthStore } from '@/store/authStore';
import { startDomTranslator } from './domTranslate';
import { FR_WORDS, FR_PHRASES } from './fr';

export type UiLang = 'en' | 'fr';

export const UI_LANGUAGES: { code: UiLang; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
];

const STORAGE_KEY = 'admin_lang';

/** Countries whose working language is French. Used only to pick a sensible default. */
const FRENCH_COUNTRIES = new Set([
  'ML', 'SN', 'CI', 'BF', 'NE', 'TG', 'BJ', 'GN', 'CM', 'GA', 'CG', 'CD', 'TD', 'CF', 'DJ', 'MG', 'BI', 'RW', 'KM', 'FR',
]);

const isUiLang = (v: unknown): v is UiLang => v === 'en' || v === 'fr';

const readChoice = (): UiLang | null => {
  try { const v = localStorage.getItem(STORAGE_KEY); return isUiLang(v) ? v : null; } catch { return null; }
};

type StaffLike = { supportCountries?: string[] | null; supportLanguages?: string[] | null; countryCode?: string | null } | null | undefined;

/** The language to open in when the person has not chosen one themselves. */
export const defaultLangFor = (user: StaffLike): UiLang => {
  const langs = (user?.supportLanguages ?? []).map(l => String(l).toLowerCase());
  if (langs.includes('fr') && !langs.includes('en')) return 'fr';
  const home = String(user?.supportCountries?.[0] ?? user?.countryCode ?? '').toUpperCase();
  if (user?.supportCountries?.length && FRENCH_COUNTRIES.has(home)) return 'fr';
  const hasHints = langs.length > 0 || (user?.supportCountries?.length ?? 0) > 0;
  if (!hasHints) {
    try { if (String(navigator.language || '').toLowerCase().startsWith('fr')) return 'fr'; } catch { /* ignore */ }
  }
  return 'en';
};

let current: UiLang = 'en';
let stop: (() => void) | null = null;

export const getLang = (): UiLang => current;

/** Locale for dates and numbers. */
export const intlLocale = (): string => (current === 'fr' ? 'fr-FR' : 'en-NG');

const apply = (lang: UiLang) => {
  current = lang;
  try { document.documentElement.lang = lang; } catch { /* ignore */ }
  if (stop) { stop(); stop = null; }
  if (lang === 'fr') stop = startDomTranslator(FR_WORDS, FR_PHRASES);
};

/** The person picks a language themselves. Reloading restores any text already translated. */
export const chooseLang = (lang: UiLang) => {
  try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* ignore */ }
  window.location.reload();
};

/** Call once at start-up, before the first render. */
export const initI18n = () => {
  const user = useAuthStore.getState().user as StaffLike;
  apply(readChoice() ?? defaultLangFor(user));

  // After someone logs in, follow their country unless they have chosen a language.
  let lastUserId: unknown = (useAuthStore.getState().user as { id?: string } | null)?.id;
  useAuthStore.subscribe((state) => {
    const u = state.user as (StaffLike & { id?: string }) | null;
    if (!u || u.id === lastUserId) return;
    lastUserId = u.id;
    if (readChoice()) return;
    const next = defaultLangFor(u);
    if (next === current) return;
    // No country or language on the account: keep whatever the person is already seeing.
    if (!(u.supportLanguages?.length) && !(u.supportCountries?.length)) return;
    if (next === 'en') window.location.reload();     // go back to untranslated text cleanly
    else apply(next);
  });
};
