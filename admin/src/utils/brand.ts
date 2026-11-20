// White label: turn one brand colour into the 50–900 palette the UI uses (CSS variables).
const hexToRgb = (hex: string): [number, number, number] | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

/** shade → "r g b". The brand colour itself is shade 600 (buttons, links); lighter/darker around it. */
export const brandPalette = (hex: string): Record<number, string> | null => {
  const base = hexToRgb(hex);
  if (!base) return null;
  const white = [255, 255, 255]; const black = [0, 0, 0];
  const out: Record<number, number[]> = {
    50: mix(base, white, 0.92), 100: mix(base, white, 0.82), 200: mix(base, white, 0.64), 300: mix(base, white, 0.45), 400: mix(base, white, 0.25),
    500: mix(base, white, 0.1), 600: base, 700: mix(base, black, 0.2), 800: mix(base, black, 0.4), 900: mix(base, black, 0.6),
  };
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join(' ')]));
};

export const applyBrandColor = (hex?: string | null) => {
  const root = document.documentElement;
  const pal = hex ? brandPalette(hex) : null;
  for (const shade of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]) {
    if (pal) root.style.setProperty(`--p-${shade}`, pal[shade]); else root.style.removeProperty(`--p-${shade}`);
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && hex) meta.setAttribute('content', hex);
};
