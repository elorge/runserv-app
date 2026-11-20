// mobile/src/theme/theme.js

export const ACCENT_COLORS = {
  // Runserv brand — matches the RS logo: electric blue #0092F5 → cyan #02BDFE on deep navy #01152B.
  runserv: {
    id: 'runserv', name: 'Runserv', emoji: '◆', accent: '#0092F5',
    dark: {
      background:      '#050E1C',
      backgroundAlt:   '#0A1830',
      card:            '#0A1626',
      border:          '#16294A',
      pill:            '#0F1E36',
      pillBorder:      '#0092F533',
      accent:          '#0092F5',
      accentFg:        '#FFFFFF',
      foreground:      '#FFFFFF',
      muted:           '#8DA2C0',
      hint:            '#6B7F9E',
      shadow:          '#0092F5',
      logoBadgeBg:     '#0A1626',
      logoBadgeBorder: '#16294A',
    },
    light: {
      background:      '#FFFFFF',
      backgroundAlt:   '#F2F7FD',
      card:            '#F8FBFF',
      border:          '#DCE7F5',
      pill:            '#E8F1FC',
      pillBorder:      '#01152B12',
      accent:          '#0092F5',
      accentFg:        '#FFFFFF',
      foreground:      '#01152B',
      muted:           '#4A5E7A',
      hint:            '#8294AE',
      shadow:          '#01152B',
      logoBadgeBg:     '#FFFFFF',
      logoBadgeBorder: '#DCE7F5',
    },
  },

  onyx: {
    id: 'onyx', name: 'Onyx', emoji: '◼', accent: '#FFFFFF',
    dark: {
      background:      '#000000',
      backgroundAlt:   '#0F0F0F',
      card:            '#0A0A0A',
      border:          '#1F1F1F',
      pill:            '#141414',
      pillBorder:      '#FFFFFF14',
      accent:          '#FFFFFF',
      accentFg:        '#000000',
      foreground:      '#FFFFFF',
      muted:           '#666666',
      hint:            '#555555',
      shadow:          '#FFFFFF',
      logoBadgeBg:     '#1A1A1A',
      logoBadgeBorder: '#2A2A2A',
    },
    light: {
      background:      '#FFFFFF',
      backgroundAlt:   '#F5F5F5',
      card:            '#FAFAFA',
      border:          '#E0E0E0',
      pill:            '#EFEFEF',
      pillBorder:      '#00000012',
      accent:          '#000000',
      accentFg:        '#FFFFFF',
      foreground:      '#000000',
      muted:           '#555555',
      hint:            '#999999',
      shadow:          '#000000',
      logoBadgeBg:     '#FFFFFF',
      logoBadgeBorder: '#E0E0E0',
    },
  },

  // chalk kept for backward compat but maps to same black/white palette
  chalk: {
    id: 'chalk', name: 'Chalk', emoji: '◻', accent: '#FFFFFF',
    dark: {
      background:      '#000000',
      backgroundAlt:   '#0F0F0F',
      card:            '#0A0A0A',
      border:          '#1F1F1F',
      pill:            '#141414',
      pillBorder:      '#FFFFFF14',
      accent:          '#FFFFFF',
      accentFg:        '#000000',
      foreground:      '#FFFFFF',
      muted:           '#666666',
      hint:            '#555555',
      shadow:          '#FFFFFF',
      logoBadgeBg:     '#1A1A1A',
      logoBadgeBorder: '#2A2A2A',
    },
    light: {
      background:      '#FFFFFF',
      backgroundAlt:   '#F5F5F5',
      card:            '#FAFAFA',
      border:          '#E0E0E0',
      pill:            '#EFEFEF',
      pillBorder:      '#00000012',
      accent:          '#000000',
      accentFg:        '#FFFFFF',
      foreground:      '#000000',
      muted:           '#555555',
      hint:            '#999999',
      shadow:          '#000000',
      logoBadgeBg:     '#FFFFFF',
      logoBadgeBorder: '#E0E0E0',
    },
  },
};

export const DEFAULT_ACCENT = 'runserv';
export const DEFAULT_MODE   = 'dark';

export function getTheme(accentId = DEFAULT_ACCENT, mode = DEFAULT_MODE) {
  const base = ACCENT_COLORS[accentId] || ACCENT_COLORS.onyx;
  return { ...base[mode], accentId, mode, name: base.name };
}

// Brand palette (from the logo) for code that is not theme-driven (maps, charts).
export const BRAND = {
  blue:  '#0092F5',
  cyan:  '#02BDFE',
  navy:  '#01152B',
  white: '#FFFFFF',
  keke:  '#FFC21A', // tricycle yellow used in the vehicle art
};
