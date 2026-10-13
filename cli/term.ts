// Terminal primitives: colour depth detection, the Aurora palette, display width and wrapping.
// Only text that has already been through sanitize() is measured or printed here.

export type Depth = 0 | 256 | 16_777_216;

export function colorDepth(env: NodeJS.ProcessEnv = process.env, isTTY = !!process.stdout.isTTY): Depth {
  if ('NO_COLOR' in env && env.NO_COLOR !== '') return 0;
  if (env.FORCE_COLOR === '0') return 0;
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return 16_777_216;
  if (/-direct|kitty|ghostty|alacritty|foot|wezterm/.test(env.TERM ?? '') || env.TERM_PROGRAM === 'WezTerm' || env.TERM_PROGRAM === 'ghostty') return 16_777_216;
  if (!isTTY && !env.FORCE_COLOR) return 0;
  if (env.TERM === 'dumb') return 0;
  return 256;
}

type RGB = [number, number, number];
// Colours can come from user data (a profile's accent), so anything that is not #rrggbb falls back.
const hex = (h: string): RGB => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h) ?? ['', 'a7', '8b', 'fa'];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
};

/** Nearest xterm-256 colour for an RGB value (cube or grey ramp, whichever is closer). */
function to256([r, g, b]: RGB): number {
  const q = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));
  const cube = 16 + 36 * q(r) + 6 * q(g) + q(b);
  const lv = [0, 95, 135, 175, 215, 255];
  const cd = (lv[q(r)] - r) ** 2 + (lv[q(g)] - g) ** 2 + (lv[q(b)] - b) ** 2;
  const grey = Math.min(23, Math.max(0, Math.round(((r + g + b) / 3 - 8) / 10)));
  const gv = 8 + grey * 10;
  const gd = (gv - r) ** 2 + (gv - g) ** 2 + (gv - b) ** 2;
  return gd < cd ? 232 + grey : cube;
}

export function makePaint(depth: Depth) {
  const fg = (h: string) => {
    if (!depth) return '';
    const c = hex(h);
    return depth === 256 ? `\x1b[38;5;${to256(c)}m` : `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;
  };
  const bg = (h: string) => {
    if (!depth) return '';
    const c = hex(h);
    return depth === 256 ? `\x1b[48;5;${to256(c)}m` : `\x1b[48;2;${c[0]};${c[1]};${c[2]}m`;
  };
  const sgr = (code: string) => (depth ? `\x1b[${code}m` : '');
  /** A left-to-right blend across the given stops, one colour per visible character. */
  const gradient = (text: string, stops: string[]) => {
    if (!depth) return text;
    const chars = [...text];
    const cs = stops.map(hex);
    return (
      chars
        .map((ch, i) => {
          const t = chars.length < 2 ? 0 : (i / (chars.length - 1)) * (cs.length - 1);
          const k = Math.min(cs.length - 2, Math.floor(t));
          const f = t - k;
          const c = cs[k].map((v, j) => Math.round(v + (cs[k + 1][j] - v) * f)) as RGB;
          return (depth === 256 ? `\x1b[38;5;${to256(c)}m` : `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`) + ch;
        })
        .join('') + sgr('39')
    );
  };
  return { fg, bg, sgr, gradient, reset: sgr('0'), bold: sgr('1'), dim: sgr('2'), italic: sgr('3'), under: sgr('4'), inverse: sgr('7') };
}
export type Paint = ReturnType<typeof makePaint>;

/** The Aurora night palette: near-black sky, warm amber to pink to violet accents. */
export const AURORA = {
  sky: '#0b0c10',
  panel: '#14151b',
  sel: '#1f1a24',
  line: '#2a2b33',
  text: '#e8e6ef',
  soft: '#a8a6b3',
  faint: '#6d6b78',
  amber: '#ffad7a',
  pink: '#ff7a9c',
  violet: '#a78bfa',
  teal: '#5eead4',
  green: '#9ece6a',
  red: '#f7768e',
};
export const ACCENT = [AURORA.amber, AURORA.pink, AURORA.violet];

// Zero-width: combining marks, variation selectors, ZWJ/ZWNJ, and similar format characters.
const ZERO = /[\u0300-\u036f\u0483-\u0489\u0591-\u05bd\u0610-\u061a\u064b-\u065f\u0e31\u0e34-\u0e3a\u200b-\u200f\u20d0-\u20ff\ufe00-\ufe0f\ufe20-\ufe2f\u{e0100}-\u{e01ef}]/u;
function charWidth(cp: number, ch: string): number {
  if (ZERO.test(ch)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x2600 && cp <= 0x27bf && /\p{Extended_Pictographic}/u.test(ch)) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}

/** Display width of plain (escape-free) text. */
export function width(text: string): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch.codePointAt(0)!, ch);
  return w;
}

/** Cut plain text to at most `max` columns, with an ellipsis when it was cut. */
export function truncate(text: string, max: number): string {
  if (max <= 0) return '';
  if (width(text) <= max) return text;
  let out = '';
  let w = 0;
  for (const ch of text) {
    const cw = charWidth(ch.codePointAt(0)!, ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

/** Pad plain text with spaces to exactly `cols` columns (truncating if longer). */
export function pad(text: string, cols: number): string {
  const t = truncate(text, cols);
  return t + ' '.repeat(Math.max(0, cols - width(t)));
}

/** Word-wrap plain text to `cols` columns. Existing newlines are kept; long words are split. */
export function wrap(text: string, cols: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (!para.trim()) {
      out.push('');
      continue;
    }
    let line = '';
    let lw = 0;
    for (const word of para.replace(/\t/g, '  ').split(/(\s+)/)) {
      if (!word) continue;
      const ww = width(word);
      if (/^\s+$/.test(word)) {
        if (lw && lw + 1 <= cols) {
          line += ' ';
          lw += 1;
        }
        continue;
      }
      if (lw + ww > cols && lw) {
        out.push(line.trimEnd());
        line = '';
        lw = 0;
      }
      if (ww > cols) {
        for (const ch of word) {
          const cw = width(ch);
          if (lw + cw > cols) {
            out.push(line);
            line = '';
            lw = 0;
          }
          line += ch;
          lw += cw;
        }
        continue;
      }
      line += word;
      lw += ww;
    }
    out.push(line.trimEnd());
  }
  return out;
}

/** Relative time like the app: "now", "5m", "3h", "2d", or a short date. */
export function ago(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
