import React from 'react';
import { Languages } from 'lucide-react';
import { UI_LANGUAGES, getLang, chooseLang, UiLang } from '@/i18n';

/** Picks the console's language. Reloads the page so everything switches cleanly. */
const LanguageSwitcher: React.FC<{ className?: string; light?: boolean }> = ({ className = '', light = false }) => (
  <label className={`inline-flex items-center gap-1.5 text-sm notranslate ${light ? 'text-white/80' : 'text-gray-500'} ${className}`} translate="no">
    <Languages className="h-4 w-4" aria-hidden="true" />
    <select
      aria-label="Language"
      value={getLang()}
      onChange={e => chooseLang(e.target.value as UiLang)}
      className={`rounded-md border px-1.5 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary-400 ${
        light ? 'bg-white/10 border-white/20 text-white' : 'bg-white border-gray-200 text-gray-700'}`}
    >
      {UI_LANGUAGES.map(l => <option key={l.code} value={l.code} className="text-gray-900">{l.label}</option>)}
    </select>
  </label>
);

export default LanguageSwitcher;
