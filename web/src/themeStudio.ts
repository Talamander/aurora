// Theme studio: a theme is a small "seed" (a key hue, three accent hues and a few dials) from
// which both the dark and the light palette are derived together in OKLCH, then checked for
// WCAG AA contrast and nudged where they fall short. Seeds are what get saved, exported and
// imported; tokens are always derived, so a theme file can only ever carry numbers and names.

import { build, rgba, THEME_PRESETS, type Base } from './themes.ts';

export type StudioFont = 'geist' | 'literata' | 'mono';

export interface ThemeSeed {
  name: string;
  /** Key hue in degrees: the lamp colour and the tint of the greys. */
  hue: number;
  /** Hues of the three stops of the warm "lit" gradient. */
  accents: [number, number, number];
  /** 0 (almost grey) to 1 (vivid). */
  chroma: number;
  /** -1 cool greys, 0 follow the key hue, 1 warm greys. */
  warmth: number;
  /** 0 soft to 1 crisp: how far text and ground are pulled apart. */
  contrast: number;
  /** 0 solid cards to 1 see-through glass. */
  glass: number;
  /** Card corner radius in px. */
  radius: number;
  density: 'comfortable' | 'compact';
  font: StudioFont;
}

export interface Derived {
  tokens: Record<string, string>;
  /** Plain-language notes on what the contrast check changed. */
  nudges: string[];
}

export const DEFAULT_SEED: ThemeSeed = {
  name: 'Untitled',
  hue: 28,
  accents: [55, 355, 280],
  chroma: 0.7,
  warmth: 0,
  contrast: 0.5,
  glass: 0.5,
  radius: 26,
  density: 'comfortable',
  font: 'geist',
};

export const FONT_STACKS: Record<StudioFont, { label: string; stack: string }> = {
  geist: { label: 'Geist', stack: "'Geist Variable', 'Geist', system-ui, sans-serif" },
  literata: { label: 'Literata', stack: "'Literata Variable', 'Literata', Georgia, serif" },
  mono: { label: 'Geist Mono', stack: "'Geist Mono Variable', 'Geist Mono', ui-monospace, monospace" },
};

// ------------------------------------------------------------------ colour math

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const wrap = (h: number) => ((h % 360) + 360) % 360;

function linToSrgb(x: number) {
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}
function srgbToLin(x: number) {
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function oklchToRgb(L: number, C: number, h: number): [number, number, number] {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (rgb: number[]) => rgb.every((v) => v >= -0.0005 && v <= 1.0005);

/** OKLCH to #rrggbb, lowering chroma until the colour fits in sRGB. */
export function oklch(L: number, C: number, h: number): string {
  L = clamp(L, 0, 1);
  let lo = 0;
  let hi = Math.max(0, C);
  let rgb = oklchToRgb(L, hi, h);
  if (!inGamut(rgb)) {
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToRgb(L, mid, h))) lo = mid;
      else hi = mid;
    }
    rgb = oklchToRgb(L, lo, h);
  }
  return '#' + rgb.map((v) => Math.round(clamp(linToSrgb(clamp(v, 0, 1)), 0, 1) * 255).toString(16).padStart(2, '0')).join('');
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** sRGB bytes to OKLCH [L, C, h]. */
export function rgbToOklch(r: number, g: number, b: number): [number, number, number] {
  const [R, G, B] = [r, g, b].map((v) => srgbToLin(v / 255));
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(a, bb), wrap((Math.atan2(bb, a) * 180) / Math.PI)];
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => srgbToLin(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Mix two hues along the short way round. */
function mixHue(a: number, b: number, t: number): number {
  const d = ((b - a + 540) % 360) - 180;
  return wrap(a + d * t);
}

// ------------------------------------------------------------------ derivation

interface Tone {
  L: number;
  C: number;
  h: number;
}

/**
 * Moves a colour's lightness away from its backgrounds until it reaches `min` contrast with all
 * of them. Returns the final colour and whether it had to move.
 */
function lift(t: Tone, bgs: string[], min: number, dir: 1 | -1): { hex: string; moved: boolean } {
  let L = t.L;
  let hex = oklch(L, t.C, t.h);
  let moved = false;
  for (let i = 0; i < 60 && bgs.some((b) => contrastRatio(hex, b) < min); i++) {
    L = clamp(L + dir * 0.01, 0, 1);
    hex = oklch(L, t.C, t.h);
    moved = true;
    if (L === 0 || L === 1) break;
  }
  return { hex, moved };
}

/** Derive one mode's tokens from a seed. Dark and light come from the same seed and the same rules. */
export function derive(seed: ThemeSeed, mode: 'dark' | 'light'): Derived {
  const s = normalizeSeed(seed);
  const dark = mode === 'dark';
  const nudges: string[] = [];
  const k = s.contrast;
  const greyHue = s.warmth >= 0 ? mixHue(s.hue, 55, s.warmth) : mixHue(s.hue, 235, -s.warmth);
  const greyC = (dark ? 0.012 : 0.008) + (dark ? 0.03 : 0.02) * s.chroma * (0.5 + 0.5 * Math.abs(s.warmth || 0.4));
  const grey = (L: number, c = greyC) => oklch(L, c, greyHue);

  const groundL = dark ? 0.16 - 0.08 * k : 0.955 + 0.02 * (1 - k) - 0.01;
  const ground = grey(groundL);
  const surface = grey(dark ? groundL + 0.045 : 0.992);
  const raised = grey(dark ? groundL + 0.09 : groundL - 0.03);
  const line = grey(dark ? groundL + 0.12 : groundL - 0.06);
  const backs = [ground, surface];

  const inkC = greyC * 0.6;
  const ink = lift({ L: dark ? 0.95 : 0.17 - 0.05 * k, C: inkC, h: greyHue }, backs, 7, dark ? 1 : -1);
  const ink2 = lift({ L: dark ? 0.78 + 0.06 * k : 0.38 - 0.04 * k, C: inkC, h: greyHue }, backs, 4.5, dark ? 1 : -1);
  const ink3 = lift({ L: dark ? 0.64 + 0.08 * k : 0.49 - 0.06 * k, C: inkC, h: greyHue }, backs, 4.5, dark ? 1 : -1);
  if (ink2.moved || ink3.moved) nudges.push(`${dark ? 'Dark' : 'Light'}: lightened grey text to keep AA contrast`.replace('lightened', dark ? 'lightened' : 'darkened'));

  const vivid = 0.05 + 0.13 * s.chroma;
  const lampTone = { L: dark ? 0.78 : 0.56, C: vivid + 0.02, h: s.hue };
  const lamp = oklch(lampTone.L, lampTone.C, lampTone.h);
  const lampInk = lift({ L: dark ? 0.84 : 0.48, C: vivid, h: s.hue }, [surface, ground], 4.5, dark ? 1 : -1);
  if (lampInk.moved) nudges.push(`${dark ? 'Dark' : 'Light'}: adjusted link colour for AA contrast`);
  // Text on the lamp: whichever of near-black or near-white reads better, then the lamp moves if needed.
  const nearDark = grey(0.16, greyC);
  const nearLight = grey(0.99, greyC * 0.3);
  let onLamp = contrastRatio(nearDark, lamp) >= contrastRatio(nearLight, lamp) ? nearDark : nearLight;
  let lampFinal = lamp;
  if (contrastRatio(onLamp, lampFinal) < 4.5) {
    const away: 1 | -1 = onLamp === nearDark ? 1 : -1;
    lampFinal = lift(lampTone, [onLamp], 4.5, away).hex;
    nudges.push(`${dark ? 'Dark' : 'Light'}: moved the button colour so its label stays readable`);
  }

  const litTones = s.accents.map((h) => ({ L: dark ? 0.8 : 0.66, C: vivid + 0.03, h }));
  const lit = litTones.map((t) => oklch(t.L, t.C, t.h)) as [string, string, string];
  const softTones = s.accents.map((h) => ({ L: dark ? 0.87 : 0.88, C: 0.03 + 0.07 * s.chroma, h }));
  const soft = softTones.map((t) => oklch(t.L, t.C, t.h)) as [string, string, string];
  // Labels sit on both gradients (the active lens and the lit buttons). Darken them until they read on every stop.
  const onLit = lift({ L: 0.2, C: greyC, h: greyHue }, [...lit, ...soft], 4.5, -1).hex;
  let litFinal = lit;
  if ([...lit, ...soft].some((c) => contrastRatio(onLit, c) < 4.5)) {
    litFinal = litTones.map((t) => lift(t, [onLit], 4.5, 1).hex) as [string, string, string];
    nudges.push(`${dark ? 'Dark' : 'Light'}: brightened the accent gradient so labels on it stay readable`);
  }
  const glow = oklch(dark ? 0.8 : 0.56, 0.04 + 0.11 * s.chroma, wrap(s.hue + 165));

  const base: Base = {
    ground, surface, raised, line,
    ink: ink.hex, ink2: ink2.hex, ink3: ink3.hex,
    lamp: lampFinal, lampInk: lampInk.hex, onLamp,
    lit: litFinal, soft, onLit, glow,
  };
  const tokens = build(base, dark);
  // Glass: how much of the aura behind a card shows through it.
  const solid = 1 - s.glass;
  tokens.card = rgba(surface, dark ? 0.38 + 0.52 * solid : 0.6 + 0.36 * solid);
  tokens.glass = rgba(raised, dark ? 0.45 + 0.45 * solid : 0.55 + 0.4 * solid);
  tokens['aura-op'] = String(Math.round((dark ? 0.25 + 0.5 * s.glass : 0.12 + 0.32 * s.glass) * 100) / 100);
  tokens['r-card'] = `${s.radius}px`;
  tokens['r-card-s'] = `${Math.round(s.radius * 0.85)}px`;
  tokens['r-m'] = `${Math.round(clamp(s.radius * 0.46, 4, 18))}px`;
  tokens['r-s'] = `${Math.round(clamp(s.radius * 0.27, 3, 12))}px`;
  tokens.display = FONT_STACKS[s.font].stack;
  return { tokens, nudges };
}

// ------------------------------------------------------------------ seeds from things

/** Clamp every field into range, so any seed (from a file, an old version, a slider) is safe. */
export function normalizeSeed(x: Partial<ThemeSeed> | null | undefined): ThemeSeed {
  const d = DEFAULT_SEED;
  const num = (v: unknown, lo: number, hi: number, fb: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fb);
  const acc = Array.isArray(x?.accents) && x!.accents.length === 3 ? (x!.accents.map((h, i) => wrap(num(h, -720, 720, d.accents[i]))) as [number, number, number]) : d.accents;
  return {
    name: cleanName(x?.name) || d.name,
    hue: wrap(num(x?.hue, -720, 720, d.hue)),
    accents: acc,
    chroma: num(x?.chroma, 0, 1, d.chroma),
    warmth: num(x?.warmth, -1, 1, d.warmth),
    contrast: num(x?.contrast, 0, 1, d.contrast),
    glass: num(x?.glass, 0, 1, d.glass),
    radius: Math.round(num(x?.radius, 4, 34, d.radius)),
    density: x?.density === 'compact' ? 'compact' : 'comfortable',
    font: x?.font === 'literata' || x?.font === 'mono' ? x.font : 'geist',
  };
}

function cleanName(v: unknown): string {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f<>{};]/g, '').trim().slice(0, 40) : '';
}

/**
 * Read a picture's pixels (RGBA bytes, any size) into a seed: the strongest hue family becomes
 * the key hue, the next distinct families become the accent gradient.
 */
export function seedFromPixels(px: Uint8ClampedArray | number[], name = 'From a picture'): { seed: ThemeSeed; swatches: string[]; mode: 'dark' | 'light' } {
  const BINS = 24;
  const weight = new Array<number>(BINS).fill(0);
  const sums = Array.from({ length: BINS }, () => [0, 0, 0, 0]);
  let lumSum = 0;
  let n = 0;
  let chromaSum = 0;
  let chromaN = 0;
  for (let i = 0; i + 3 < px.length; i += 4) {
    if (px[i + 3] < 128) continue;
    const [L, C, h] = rgbToOklch(px[i], px[i + 1], px[i + 2]);
    lumSum += L;
    n++;
    if (C < 0.035 || L < 0.12 || L > 0.97) continue;
    const bin = Math.floor(h / (360 / BINS)) % BINS;
    const w = C * (0.4 + L);
    weight[bin] += w;
    const sm = sums[bin];
    sm[0] += px[i] * w;
    sm[1] += px[i + 1] * w;
    sm[2] += px[i + 2] * w;
    sm[3] += w;
    chromaSum += C;
    chromaN++;
  }
  const order = weight.map((w, i) => [w, i] as const).filter(([w]) => w > 0).sort((a, b) => b[0] - a[0]);
  const binHue = (i: number) => (i + 0.5) * (360 / BINS);
  const picked: number[] = [];
  for (const [, i] of order) {
    const h = binHue(i);
    if (picked.every((p) => Math.abs(((h - p + 540) % 360) - 180) >= 28)) picked.push(h);
    if (picked.length === 4) break;
  }
  const swatches = order.slice(0, 6).map(([, i]) => {
    const sm = sums[i];
    return '#' + [sm[0], sm[1], sm[2]].map((v) => Math.round(v / sm[3]).toString(16).padStart(2, '0')).join('');
  });
  const key = picked[0] ?? 28;
  const rest = picked.slice(1);
  const accents: [number, number, number] = [
    rest[0] ?? wrap(key + 32),
    key,
    rest[1] ?? wrap(key - 40),
  ];
  const avgC = chromaN ? chromaSum / chromaN : 0;
  const warmKey = key < 100 || key > 330;
  const seed = normalizeSeed({
    ...DEFAULT_SEED,
    name,
    hue: key,
    accents,
    chroma: chromaN / Math.max(1, n) < 0.08 ? 0.25 : clamp(avgC / 0.13, 0.3, 1),
    warmth: warmKey ? 0.45 : -0.3,
  });
  return { seed, swatches, mode: n && lumSum / n > 0.7 ? 'light' : 'dark' };
}

/** A seed that approximates a set of tokens (for example a theme the AI just set), so it can be tuned by hand. */
export function seedFromTokens(tokens: Record<string, string>, name = 'From the AI'): ThemeSeed | null {
  const hexes = (v?: string) => (v ?? '').match(/#[0-9a-f]{6}\b/gi) ?? [];
  const lamp = hexes(tokens.lamp)[0];
  const lit = hexes(tokens.lit);
  const ground = hexes(tokens.ground)[0];
  if (!lamp && lit.length < 2) return null;
  const toLch = (h: string) => rgbToOklch(...hexToRgb(h));
  const key = lamp ? toLch(lamp) : toLch(lit[1]);
  const acc = lit.length >= 3 ? lit.slice(0, 3).map((h) => toLch(h)[2]) : [wrap(key[2] + 32), key[2], wrap(key[2] - 40)];
  const g = ground ? toLch(ground) : null;
  const warmth = g && g[1] > 0.008 ? (g[2] < 110 || g[2] > 320 ? 0.4 : -0.35) : 0;
  return normalizeSeed({ ...DEFAULT_SEED, name, hue: key[2], accents: acc as [number, number, number], chroma: clamp(key[1] / 0.17, 0.15, 1), warmth, contrast: g ? clamp((0.16 - g[0]) / 0.08, 0, 1) : 0.5 });
}

// ------------------------------------------------------------------ files

export const THEME_FILE_MAX = 8 * 1024;
const FILE_KEYS = new Set(['kind', 'version', 'name', 'seed', 'exportedAt']);
const SEED_KEYS = new Set(Object.keys(DEFAULT_SEED));

export function themeFile(seed: ThemeSeed): string {
  return JSON.stringify({ kind: 'aurora-theme', version: 1, name: seed.name, exportedAt: new Date().toISOString(), seed: normalizeSeed(seed) }, null, 2);
}

/** Parse a .aurora-theme.json file. Only the seed's known fields are read; everything else is ignored. */
export function parseThemeFile(text: string): { seed: ThemeSeed; ignored: number } {
  if (text.length > THEME_FILE_MAX) throw new Error('That file is too big to be an Aurora theme.');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  const o = data as Record<string, unknown>;
  if (!o || typeof o !== 'object' || o.kind !== 'aurora-theme' || o.version !== 1) throw new Error('That is not an Aurora theme file.');
  const raw = o.seed as Record<string, unknown>;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The theme file has no colours in it.');
  let ignored = Object.keys(o).filter((x) => !FILE_KEYS.has(x)).length;
  const picked: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(raw)) {
    if (!SEED_KEYS.has(key)) {
      ignored++;
      continue;
    }
    if (key === 'accents') {
      if (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x))) picked.accents = v;
      else ignored++;
    } else if (key === 'name' || key === 'density' || key === 'font') {
      if (typeof v === 'string') picked[key] = v;
      else ignored++;
    } else if (typeof v === 'number' && Number.isFinite(v)) picked[key] = v;
    else ignored++;
  }
  const seed = normalizeSeed({ ...(picked as Partial<ThemeSeed>), name: (picked.name as string) ?? cleanName(o.name) });
  return { seed, ignored };
}

// ------------------------------------------------------------------ presets

export interface SavedTheme {
  id: string;
  seed: ThemeSeed;
}

export const STUDIO_PREFIX = 'studio-';

/** Register a seed as a preset (both modes) in THEME_PRESETS. */
export function registerSeed(id: string, seed: ThemeSeed): void {
  THEME_PRESETS[id] = { label: seed.name, dark: derive(seed, 'dark').tokens, light: derive(seed, 'light').tokens };
}

/** Replace the saved studio presets in THEME_PRESETS with this list. */
export function registerSaved(list: SavedTheme[]): void {
  for (const id of Object.keys(THEME_PRESETS)) if (id.startsWith(STUDIO_PREFIX)) delete THEME_PRESETS[id];
  for (const t of list) if (/^studio-[a-z0-9]{4,16}$/.test(t.id)) registerSeed(t.id, normalizeSeed(t.seed));
}

export function newThemeId(): string {
  return STUDIO_PREFIX + Math.random().toString(36).slice(2, 10).padEnd(6, '0');
}
