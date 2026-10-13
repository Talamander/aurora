// Theme presets for the Aurora look. Each preset overrides the CSS custom properties
// defined on :root in styles.css (names without the leading "--"). "aurora" is the
// built-in default and carries no overrides.

type Tokens = Record<string, string>;

export interface ThemePreset {
  label: string;
  dark: Tokens;
  light?: Tokens;
}

export interface Base {
  ground: string;
  surface: string;
  raised: string;
  line: string;
  ink: string;
  ink2: string;
  ink3: string;
  lamp: string;
  lampInk: string;
  onLamp: string;
  /** Three accent colours for the warm "lit" gradient. */
  lit: [string, string, string];
  /** Three paler colours for the soft gradient behind active lenses. */
  soft: [string, string, string];
  onLit: string;
  glow: string;
  /** Error and warning text, when the default red does not read on this ground. */
  warn?: string;
}

export function rgba(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export function build(b: Base, dark: boolean): Tokens {
  return {
    ground: b.ground,
    surface: b.surface,
    raised: b.raised,
    line: b.line,
    ink: b.ink,
    'ink-2': b.ink2,
    'ink-3': b.ink3,
    lamp: b.lamp,
    'lamp-ink': b.lampInk,
    'lamp-wash': rgba(b.lamp, dark ? 0.12 : 0.09),
    'lamp-soft': rgba(b.lamp, dark ? 0.2 : 0.16),
    'on-lamp': b.onLamp,
    sel: rgba(b.lamp, dark ? 0.06 : 0.05),
    lit: `linear-gradient(100deg, ${b.lit[0]}, ${b.lit[1]} 58%, ${b.lit[2]})`,
    'lit-soft': `linear-gradient(160deg, ${b.soft[0]}, ${b.soft[1]} 55%, ${b.soft[2]})`,
    'on-lit': b.onLit,
    'glow-on': b.glow,
    'glow-shadow': dark ? `0 0 16px -2px ${rgba(b.glow, 0.6)}` : '0 0 0 transparent',
    card: rgba(b.surface, dark ? 0.62 : 0.82),
    'card-line': rgba(b.ink, dark ? 0.08 : 0.08),
    glass: rgba(b.raised, dark ? 0.58 : 0.66),
    'glass-line': rgba(b.ink, dark ? 0.12 : 0.1),
    'aura-op': dark ? '0.55' : '0.3',
    ...(b.warn ? { warn: b.warn } : {}),
  };
}

const d = (b: Base) => build(b, true);
const l = (b: Base) => build(b, false);

export const THEME_PRESETS: Record<string, ThemePreset> = {
  aurora: { label: 'Aurora', dark: {}, light: {} },

  'tokyo-night': {
    label: 'Tokyo Night',
    dark: d({
      ground: '#16161e', surface: '#1a1b26', raised: '#24283b', line: '#292e42',
      ink: '#c0caf5', ink2: '#a9b1d6', ink3: '#8b92bd',
      lamp: '#7aa2f7', lampInk: '#9cbcff', onLamp: '#16161e',
      lit: ['#ff9e64', '#f7768e', '#bb9af7'], soft: ['#e0af68', '#ff9e64', '#f7768e'], onLit: '#16161e',
      glow: '#73daca',
    }),
    light: l({
      ground: '#d5d6db', surface: '#e1e2e7', raised: '#c8c9d1', line: '#c4c5cc',
      ink: '#1f2335', ink2: '#343b58', ink3: '#484e70',
      lamp: '#1f63cc', lampInk: '#1a55ad', onLamp: '#ffffff',
      lit: ['#b15c00', '#f52a65', '#9854f1'], soft: ['#f0c48a', '#ffa98f', '#d6b8ff'], onLit: '#1f2335',
      glow: '#118c74', warn: '#a82e15',
    }),
  },

  catppuccin: {
    label: 'Catppuccin',
    dark: d({
      ground: '#181825', surface: '#1e1e2e', raised: '#313244', line: '#313244',
      ink: '#cdd6f4', ink2: '#bac2de', ink3: '#989eb7',
      lamp: '#cba6f7', lampInk: '#d9bcfa', onLamp: '#11111b',
      lit: ['#fab387', '#f38ba8', '#cba6f7'], soft: ['#f9e2af', '#fab387', '#f5c2e7'], onLit: '#11111b',
      glow: '#94e2d5',
    }),
    light: l({
      ground: '#e6e9ef', surface: '#eff1f5', raised: '#dce0e8', line: '#ccd0da',
      ink: '#2f3146', ink2: '#4c4f69', ink3: '#5c5f77',
      lamp: '#8839ef', lampInk: '#7024d6', onLamp: '#ffffff',
      lit: ['#fe640b', '#ea76cb', '#8839ef'], soft: ['#f7d9a6', '#fbb894', '#f1b8e3'], onLit: '#2f3146',
      glow: '#179299',
    }),
  },

  gruvbox: {
    label: 'Gruvbox',
    dark: d({
      ground: '#1d2021', surface: '#282828', raised: '#32302f', line: '#3c3836',
      ink: '#ebdbb2', ink2: '#d5c4a1', ink3: '#a89984',
      lamp: '#fe8019', lampInk: '#fe9a4a', onLamp: '#1d2021',
      lit: ['#fabd2f', '#fe8019', '#fb4934'], soft: ['#fabd2f', '#fe8019', '#d3869b'], onLit: '#1d2021',
      glow: '#8ec07c',
    }),
    light: l({
      ground: '#f2e5bc', surface: '#fbf1c7', raised: '#ebdbb2', line: '#d5c4a1',
      ink: '#282828', ink2: '#3c3836', ink3: '#5a524c',
      lamp: '#af3a03', lampInk: '#9a3203', onLamp: '#fbf1c7',
      lit: ['#b57614', '#af3a03', '#9d0006'], soft: ['#fabd2f', '#fe8019', '#d3869b'], onLit: '#282828',
      glow: '#427b58',
    }),
  },

  nord: {
    label: 'Nord',
    dark: d({
      ground: '#242933', surface: '#2e3440', raised: '#3b4252', line: '#3b4252',
      ink: '#eceff4', ink2: '#d8dee9', ink3: '#a8b2c6',
      lamp: '#88c0d0', lampInk: '#a3d2df', onLamp: '#242933',
      lit: ['#d08770', '#b48ead', '#81a1c1'], soft: ['#ebcb8b', '#d08770', '#b48ead'], onLit: '#242933',
      glow: '#8fbcbb',
    }),
    light: l({
      ground: '#e5e9f0', surface: '#eceff4', raised: '#d8dee9', line: '#d8dee9',
      ink: '#2e3440', ink2: '#3b4252', ink3: '#4c566a',
      lamp: '#4c6a91', lampInk: '#3e5878', onLamp: '#ffffff',
      lit: ['#d08770', '#b48ead', '#5e81ac'], soft: ['#ebcb8b', '#e3ad98', '#cdb3c9'], onLit: '#2e3440',
      glow: '#4f8f8e',
    }),
  },

  'rose-pine': {
    label: 'Rosé Pine',
    dark: d({
      ground: '#191724', surface: '#1f1d2e', raised: '#26233a', line: '#2a273f',
      ink: '#e0def4', ink2: '#c4c1de', ink3: '#908caa',
      lamp: '#ebbcba', lampInk: '#f2cfcd', onLamp: '#191724',
      lit: ['#f6c177', '#eb6f92', '#c4a7e7'], soft: ['#f6c177', '#ebbcba', '#c4a7e7'], onLit: '#191724',
      glow: '#9ccfd8',
    }),
    light: l({
      ground: '#f2e9e1', surface: '#faf4ed', raised: '#f4ede8', line: '#dfdad9',
      ink: '#3a3557', ink2: '#575279', ink3: '#625e80',
      lamp: '#a04f66', lampInk: '#8f4359', onLamp: '#fffaf3',
      lit: ['#ea9d34', '#d7827e', '#907aa9'], soft: ['#f5d3a0', '#efbcb8', '#d6c6e6'], onLit: '#3a3557',
      glow: '#286983',
    }),
  },

  everforest: {
    label: 'Everforest',
    dark: d({
      ground: '#232a2e', surface: '#2d353b', raised: '#343f44', line: '#3d484d',
      ink: '#d3c6aa', ink2: '#c0b597', ink3: '#a3aea5',
      lamp: '#a7c080', lampInk: '#bbd199', onLamp: '#232a2e',
      lit: ['#dbbc7f', '#e69875', '#d699b6'], soft: ['#dbbc7f', '#e69875', '#e67e80'], onLit: '#232a2e',
      glow: '#83c092',
    }),
    light: l({
      ground: '#f4f0d9', surface: '#fdf6e3', raised: '#efebd4', line: '#e0dcc7',
      ink: '#323d43', ink2: '#4a565c', ink3: '#58666c',
      lamp: '#8da101', lampInk: '#5f6d00', onLamp: '#232a2e',
      lit: ['#dfa000', '#f57d26', '#df69ba'], soft: ['#f0d78f', '#f7b98a', '#efb2d8'], onLit: '#323d43',
      glow: '#2f9970',
    }),
  },

  kanagawa: {
    label: 'Kanagawa',
    dark: d({
      ground: '#16161d', surface: '#1f1f28', raised: '#2a2a37', line: '#363646',
      ink: '#dcd7ba', ink2: '#c8c093', ink3: '#a09d8a',
      lamp: '#7e9cd8', lampInk: '#9cb4e4', onLamp: '#16161d',
      lit: ['#ffa066', '#d27e99', '#957fb8'], soft: ['#e6c384', '#ffa066', '#d27e99'], onLit: '#16161d',
      glow: '#7aa89f',
    }),
    light: l({
      ground: '#e7dba0', surface: '#f2ecbc', raised: '#e4d794', line: '#d5cea3',
      ink: '#1f1f28', ink2: '#43436c', ink3: '#545464',
      lamp: '#4d699b', lampInk: '#3d5480', onLamp: '#f2ecbc',
      lit: ['#cc6d00', '#b35b79', '#624c83'], soft: ['#e8c37a', '#e5a68a', '#c9a6c6'], onLit: '#1f1f28',
      glow: '#597b75',
    }),
  },

  'matte-black': {
    label: 'Matte Black',
    dark: d({
      ground: '#0b0b0b', surface: '#121212', raised: '#1c1c1c', line: '#262626',
      ink: '#eaeaea', ink2: '#bebebe', ink3: '#8f8f8f',
      lamp: '#f59e0b', lampInk: '#ffb534', onLamp: '#0b0b0b',
      lit: ['#ffc107', '#e68e0d', '#d35f5f'], soft: ['#ffd36b', '#f5b14a', '#e28a8a'], onLit: '#0b0b0b',
      glow: '#f59e0b',
    }),
  },

  'osaka-jade': {
    label: 'Osaka Jade',
    dark: d({
      ground: '#0c1512', surface: '#111c18', raised: '#1a2a24', line: '#23372b',
      ink: '#f6f5dd', ink2: '#c1c497', ink3: '#93a088',
      lamp: '#2dd5b7', lampInk: '#5fe3cb', onLamp: '#0c1512',
      lit: ['#e5c736', '#549e6a', '#2dd5b7'], soft: ['#efdc80', '#9fd3a3', '#7fe8d4'], onLit: '#0c1512',
      glow: '#2dd5b7',
    }),
  },

  ristretto: {
    label: 'Ristretto',
    dark: d({
      ground: '#211c1c', surface: '#2c2525', raised: '#403838', line: '#403838',
      ink: '#fff1f3', ink2: '#d6c9ca', ink3: '#ada3a4',
      lamp: '#f9cc6c', lampInk: '#fbd88e', onLamp: '#211c1c',
      lit: ['#f9cc6c', '#f38d70', '#fd6883'], soft: ['#f9cc6c', '#f38d70', '#a8a9eb'], onLit: '#211c1c',
      glow: '#85dacc',
    }),
  },

  solarized: {
    label: 'Solarized',
    dark: d({
      ground: '#00212b', surface: '#002b36', raised: '#073642', line: '#0b3d4a',
      ink: '#eee8d5', ink2: '#a3b1b1', ink3: '#8d9d9e',
      lamp: '#4aa3e0', lampInk: '#6fb7ea', onLamp: '#00212b',
      lit: ['#b58900', '#cb4b16', '#d33682'], soft: ['#e3c26b', '#e8956f', '#e88bb5'], onLit: '#002b36',
      glow: '#2aa198',
    }),
    light: l({
      ground: '#eee8d5', surface: '#fdf6e3', raised: '#e8e1cc', line: '#ddd6c1',
      ink: '#073642', ink2: '#2f4a52', ink3: '#4f6369',
      lamp: '#1b6aa5', lampInk: '#165a8c', onLamp: '#fdf6e3',
      lit: ['#b58900', '#cb4b16', '#d33682'], soft: ['#efd58f', '#f0b293', '#f0b1cc'], onLit: '#073642',
      glow: '#1f7f78',
    }),
  },
};

export type Look = { preset?: string; mode?: 'dark' | 'light'; tokens?: Record<string, string> } | null;

const KEY_RE = /^[a-z0-9-]{1,24}$/;
// Also refuses backslashes (a CSS escape spells url( without the letters) and every function that
// loads a resource, so a stored look can never fetch from another host.
const BAD_VALUE = /[;{}<>\\]|url\(|image-set|image\(|cross-fade|element\(|src\(|paint\(/i;
let applied = new Set<string>();

export function safe(key: string, value: unknown): value is string {
  return KEY_RE.test(key) && typeof value === 'string' && value.length > 0 && value.length <= 400 && !BAD_VALUE.test(value);
}

/** Paint a look onto the document root as inline custom properties. Pass null for plain Aurora. */
export function applyLook(look: Look, mode: 'dark' | 'light'): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const next: Record<string, string> = {};
  const preset = look?.preset ? THEME_PRESETS[look.preset] : undefined;
  if (preset) {
    const palette = mode === 'light' ? preset.light ?? preset.dark : preset.dark;
    for (const [k, v] of Object.entries(palette)) if (safe(k, v)) next[k] = v;
  }
  if (look?.tokens) for (const [k, v] of Object.entries(look.tokens)) if (safe(k, v)) next[k] = v;

  for (const k of applied) if (!(k in next)) root.style.removeProperty(`--${k}`);
  for (const [k, v] of Object.entries(next)) root.style.setProperty(`--${k}`, v);
  applied = new Set(Object.keys(next));
}

export interface DesktopTheme {
  source: 'omarchy';
  name: string;
  mode: 'dark' | 'light';
  colors: Record<string, string>;
}

/** "Match my desktop": registers (or removes) the 'desktop' preset built from Omarchy's colours. */
export function setDesktopPreset(t: DesktopTheme | null): void {
  if (!t) {
    delete THEME_PRESETS.desktop;
    return;
  }
  const c = t.colors;
  const dark = t.mode === 'dark';
  const pick = (...keys: string[]) => keys.map((k) => c[k]).find(Boolean) as string;
  const b: Base = {
    ground: pick(dark ? 'dark_background' : 'background', 'background'),
    surface: pick(dark ? 'background' : 'lighter_background', 'background'),
    raised: pick('lighter_background', 'selection', 'background'),
    line: pick('selection', 'lighter_background', 'muted'),
    ink: pick('foreground'),
    ink2: pick('light_foreground', 'foreground'),
    ink3: pick('dark_foreground', 'muted', 'foreground'),
    lamp: pick('accent'),
    lampInk: pick('accent'),
    onLamp: pick('darker_background', 'dark_background', 'background'),
    lit: [pick('orange', 'yellow', 'accent'), pick('red', 'magenta', 'accent'), pick('magenta', 'blue', 'accent')],
    soft: [pick('yellow', 'orange', 'accent'), pick('orange', 'red', 'accent'), pick('red', 'magenta', 'accent')],
    onLit: pick('darker_background', 'dark_background', 'background'),
    glow: pick('cyan', 'green', 'accent'),
  };
  const tokens = build(b, dark);
  const name = t.name.replace(/(^|-)([a-z])/g, (_m, s: string, ch: string) => `${s ? ' ' : ''}${ch.toUpperCase()}`);
  THEME_PRESETS.desktop = { label: `Desktop · ${name}`, dark: tokens, light: tokens };
}
